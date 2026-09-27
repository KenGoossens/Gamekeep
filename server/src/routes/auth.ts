import { randomUUID } from 'node:crypto';
import { originOf } from '../auth/origin.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import {
  generateTempPassword,
  hashPassword,
  validatePassword,
  validateUsername,
  verifyPassword,
} from '../auth/passwords.js';

/** Throttle keys: one per account, one per source address. */
const throttleKeys = (request: FastifyRequest, username: string) => [
  `user:${username.toLowerCase()}`,
  `ip:${request.ip}`,
];

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, sessions, setup, guard, throttle } = ctx;

  /** Unauthenticated: tells the UI which screen to show. */
  app.get('/api/auth/status', async (request, reply) => {
    const user = sessions.resolve(request);
    return reply.send({
      needsSetup: setup.needsSetup(),
      authenticated: Boolean(user),
      mustChangePassword: user?.mustChangePassword ?? false,
    });
  });

  app.post<{ Body: { token?: string; username?: string; password?: string } }>(
    '/api/auth/setup',
    async (request, reply) => {
      const body = request.body ?? {};

      // Re-checked here rather than trusted from the client: this is the only
      // route that can mint an admin out of nothing.
      if (!setup.needsSetup()) {
        return reply.code(409).send({ error: 'setup-already-complete' });
      }
      if (!setup.verify(body.token)) {
        request.log.warn({ ip: request.ip }, 'setup attempted with a bad token');
        db.audit({
          userId: null,
          username: String(body.username ?? 'unknown').slice(0, 64),
          serverId: null,
          action: 'setup',
          result: 'denied',
          detail: `Bad setup token from ${request.ip}`,
          ...originOf(request),
        });
        return reply.code(403).send({ error: 'bad-setup-token' });
      }

      const usernameError = validateUsername(body.username);
      if (usernameError) return reply.code(400).send({ error: 'invalid-username', message: usernameError });
      const passwordError = validatePassword(body.password);
      if (passwordError) return reply.code(400).send({ error: 'invalid-password', message: passwordError });

      const username = body.username as string;
      const id = randomUUID();
      db.createUser({
        id,
        username,
        passwordHash: await hashPassword(body.password as string),
        role: 'owner',
        mustChangePassword: false,
        createdBy: null,
      });
      setup.complete();
      // Setup signs you straight in, so record it as a login.
      db.touchLogin(id);

      db.audit({
        userId: id,
        username,
        serverId: null,
        action: 'setup',
        result: 'success',
        detail: 'First administrator created',
        ...originOf(request),
      });
      request.log.info({ username }, 'first administrator created');

      sessions.create(reply, id);
      return reply.send({ username, role: 'owner' });
    },
  );

  app.post<{ Body: { username?: string; password?: string } }>(
    '/api/auth/login',
    async (request, reply) => {
      const username = typeof request.body?.username === 'string' ? request.body.username : '';
      const password = typeof request.body?.password === 'string' ? request.body.password : '';
      const keys = throttleKeys(request, username);

      const retryAfter = throttle.retryAfter(keys);
      if (retryAfter > 0) {
        return reply
          .code(429)
          .header('retry-after', String(retryAfter))
          .send({ error: 'too-many-attempts', retryAfterSeconds: retryAfter });
      }

      const user = username ? db.findByUsername(username) : undefined;
      // Hash even when the user does not exist, so a missing account and a wrong
      // password take the same time and cannot be told apart.
      const stored = user?.passwordHash ?? '$scrypt$0$0$0$x$x';
      const ok = (await verifyPassword(password, stored)) && Boolean(user) && !user!.disabled;

      if (!ok) {
        throttle.recordFailure(keys);
        db.audit({
          userId: user?.id ?? null,
          username: username.slice(0, 64) || '(blank)',
          serverId: null,
          action: 'login-failed',
          result: 'denied',
          detail: user?.disabled ? `Account disabled (from ${request.ip})` : `From ${request.ip}`,
          ...originOf(request),
        });
        request.log.warn({ username, ip: request.ip }, 'failed login');
        // One message for every failure mode: no account enumeration.
        return reply.code(401).send({ error: 'invalid-credentials' });
      }

      throttle.clear(keys);
      db.touchLogin(user!.id);
      sessions.create(reply, user!.id);
      db.audit({
        userId: user!.id,
        username: user!.username,
        serverId: null,
        action: 'login',
        result: 'success',
        detail: null,
        ...originOf(request),
      });

      return reply.send({
        username: user!.username,
        role: user!.role,
        mustChangePassword: user!.mustChangePassword,
      });
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const user = sessions.resolve(request);
    sessions.destroy(request, reply);
    if (user) {
      db.audit({
        userId: user.id,
        username: user.username,
        serverId: null,
        action: 'logout',
        result: 'success',
        detail: null,
        ...originOf(request),
      });
    }
    return reply.send({ ok: true });
  });

  // requireUser, not requireActiveUser: someone holding a temporary password
  // must be able to reach exactly this route.
  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>(
    '/api/auth/change-password',
    { preHandler: guard.requireUser },
    async (request, reply) => {
      const me = request.user!;
      const current = typeof request.body?.currentPassword === 'string' ? request.body.currentPassword : '';
      const next = typeof request.body?.newPassword === 'string' ? request.body.newPassword : '';

      const stored = db.findByUsername(me.username);
      if (!stored || !(await verifyPassword(current, stored.passwordHash))) {
        return reply.code(400).send({ error: 'wrong-current-password' });
      }

      const passwordError = validatePassword(next);
      if (passwordError) return reply.code(400).send({ error: 'invalid-password', message: passwordError });
      if (next === current) return reply.code(400).send({ error: 'password-unchanged' });

      db.setPassword(me.id, await hashPassword(next), false);
      // Every other session for this account is dropped, then a fresh one is
      // issued here -- so a changed password logs out anyone else holding it.
      db.deleteUserSessions(me.id);
      sessions.create(reply, me.id);

      db.audit({
        userId: me.id,
        username: me.username,
        serverId: null,
        action: 'password-changed',
        result: 'success',
        detail: null,
        ...originOf(request),
      });
      return reply.send({ ok: true });
    },
  );

  app.get('/api/me', { preHandler: guard.requireUser }, async (request, reply) => {
    const me = request.user!;
    return reply.send({
      id: me.id,
      username: me.username,
      role: me.role,
      mustChangePassword: me.mustChangePassword,
    });
  });
}

export { generateTempPassword };
