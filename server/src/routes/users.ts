import { randomUUID } from 'node:crypto';
import { originOf } from '../auth/origin.js';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { generateTempPassword, hashPassword, validateUsername } from '../auth/passwords.js';
import { ROLES, type Role, type UserRow } from '../db.js';

const view = (u: UserRow) => ({
  id: u.id,
  username: u.username,
  role: u.role,
  disabled: u.disabled,
  mustChangePassword: u.mustChangePassword,
  createdAt: u.createdAt,
  lastLoginAt: u.lastLoginAt,
});

export function registerUserRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, guard } = ctx;
  const owner = { preHandler: guard.requireOwner };

  app.get('/api/users', owner, async (_request, reply) =>
    reply.send({ users: db.listUsers().map(view) }),
  );

  app.post<{ Body: { username?: string; role?: string } }>(
    '/api/users',
    owner,
    async (request, reply) => {
      const me = request.user!;
      const usernameError = validateUsername(request.body?.username);
      if (usernameError) {
        return reply.code(400).send({ error: 'invalid-username', message: usernameError });
      }
      const username = request.body!.username as string;
      // An owner can only be made by promoting someone afterwards, so a typo
      // here cannot hand out the keys.
      const requestedRole: Role = request.body?.role === 'operator' ? 'operator' : 'member';

      if (db.findByUsername(username)) {
        return reply.code(409).send({ error: 'username-taken' });
      }

      // The admin never chooses the password, so they never know it once the
      // user has logged in and been forced to set their own.
      const tempPassword = generateTempPassword();
      const id = randomUUID();
      db.createUser({
        id,
        username,
        passwordHash: await hashPassword(tempPassword),
        role: requestedRole,
        mustChangePassword: true,
        createdBy: me.id,
      });

      db.audit({
        userId: me.id,
        username: me.username,
        serverId: null,
        action: 'user-created',
        result: 'success',
        detail: `Created ${username} as ${requestedRole}`,
        ...originOf(request),
      });

      const created = db.findById(id)!;
      // Shown to the admin exactly once; it is not stored anywhere in the clear.
      return reply.code(201).send({ user: view(created), tempPassword });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/users/:id/reset-password',
    owner,
    async (request, reply) => {
      const me = request.user!;
      const target = db.findById(request.params.id);
      if (!target) return reply.code(404).send({ error: 'unknown-user' });

      const tempPassword = generateTempPassword();
      db.setPassword(target.id, await hashPassword(tempPassword), true);
      // Force them back through login with the new temporary password.
      db.deleteUserSessions(target.id);

      db.audit({
        userId: me.id,
        username: me.username,
        serverId: null,
        action: 'password-reset',
        result: 'success',
        detail: `Reset the password for ${target.username}`,
        ...originOf(request),
      });
      return reply.send({ tempPassword });
    },
  );

  app.post<{ Params: { id: string }; Body: { role?: string } }>(
    '/api/users/:id/role',
    owner,
    async (request, reply) => {
      const me = request.user!;
      const target = db.findById(request.params.id);
      if (!target) return reply.code(404).send({ error: 'unknown-user' });
      const role = request.body?.role;
      if (typeof role !== 'string' || !ROLES.includes(role as Role)) {
        return reply.code(400).send({ error: 'invalid-role' });
      }
      const next = role as Role;
      if (next === target.role) return reply.send({ user: view(target) });

      // Never let the portal end up with nobody who can manage the accounts.
      if (target.role === 'owner' && next !== 'owner' && db.activeOwnerCount() <= 1) {
        return reply.code(409).send({ error: 'last-owner' });
      }

      db.setRole(target.id, next);
      // A reduction in rights takes effect at once, not at their next login.
      if (next === 'member') db.deleteUserSessions(target.id);

      db.audit({
        userId: me.id,
        username: me.username,
        serverId: null,
        action: next === 'member' ? 'user-demoted' : 'user-promoted',
        result: 'success',
        detail: `${target.username}: ${target.role} -> ${next}`,
        ...originOf(request),
      });
      return reply.send({ user: view(db.findById(target.id)!) });
    },
  );

  app.post<{ Params: { id: string }; Body: { disabled?: boolean } }>(
    '/api/users/:id/disabled',
    owner,
    async (request, reply) => {
      const me = request.user!;
      const target = db.findById(request.params.id);
      if (!target) return reply.code(404).send({ error: 'unknown-user' });
      if (typeof request.body?.disabled !== 'boolean') {
        return reply.code(400).send({ error: 'invalid-body' });
      }
      const disabled = request.body.disabled;

      if (target.id === me.id && disabled) {
        return reply.code(409).send({ error: 'cannot-disable-self' });
      }
      if (disabled && target.role === 'owner' && db.activeOwnerCount() <= 1) {
        return reply.code(409).send({ error: 'last-owner' });
      }

      db.setDisabled(target.id, disabled);
      if (disabled) db.deleteUserSessions(target.id);

      db.audit({
        userId: me.id,
        username: me.username,
        serverId: null,
        action: disabled ? 'user-disabled' : 'user-enabled',
        result: 'success',
        detail: `${disabled ? 'Disabled' : 'Enabled'} ${target.username}`,
        ...originOf(request),
      });
      return reply.send({ user: view(db.findById(target.id)!) });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/users/:id', owner, async (request, reply) => {
    const me = request.user!;
    const target = db.findById(request.params.id);
    if (!target) return reply.code(404).send({ error: 'unknown-user' });

    // Deleting yourself is never what you meant, and it can strand the portal.
    if (target.id === me.id) return reply.code(409).send({ error: 'cannot-delete-self' });
    if (target.role === 'owner' && db.activeOwnerCount() <= 1) {
      return reply.code(409).send({ error: 'last-owner' });
    }

    db.deleteUser(target.id);
    db.audit({
      userId: me.id,
      username: me.username,
      serverId: null,
      action: 'user-deleted',
      result: 'success',
      detail: `Deleted ${target.username}`,
      ...originOf(request),
    });
    return reply.send({ ok: true });
  });
}
