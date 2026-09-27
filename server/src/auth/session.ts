import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from '../config.js';
import type { Db, SessionUser } from '../db.js';

export const SESSION_COOKIE = 'gamekeep_session';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export function createSessions(env: Env, db: Db) {
  const cookieOptions = {
    httpOnly: true,
    secure: env.PUBLIC_URL.startsWith('https://'),
    // Lax blocks the cookie on cross-site POSTs, which is the CSRF case that
    // matters here since every state-changing route is a POST.
    sameSite: 'lax' as const,
    path: '/',
    signed: true,
  };

  function create(reply: FastifyReply, userId: string): string {
    const id = randomBytes(32).toString('base64url');
    db.createSession(id, userId, Date.now() + SESSION_TTL_MS);
    reply.setCookie(SESSION_COOKIE, id, {
      ...cookieOptions,
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return id;
  }

  function readSessionId(request: FastifyRequest): string | null {
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return null;
    const unsigned = request.unsignCookie(raw);
    return unsigned.valid ? unsigned.value : null;
  }

  function destroy(request: FastifyRequest, reply: FastifyReply) {
    const id = readSessionId(request);
    if (id) db.deleteSession(id);
    reply.clearCookie(SESSION_COOKIE, { ...cookieOptions });
  }

  /**
   * Resolves the caller on every request. A disabled account is rejected and
   * its sessions destroyed immediately, so disabling someone locks them out
   * without waiting for their cookie to expire.
   */
  function resolve(request: FastifyRequest): SessionUser | null {
    const id = readSessionId(request);
    if (!id) return null;

    const user = db.sessionUser(id);
    if (!user) return null;

    if (user.disabled) {
      db.deleteUserSessions(user.id);
      return null;
    }
    return user;
  }

  function startSweeper(): NodeJS.Timeout {
    db.sweepExpiredSessions();
    const timer = setInterval(() => db.sweepExpiredSessions(), 60 * 60 * 1000);
    timer.unref();
    return timer;
  }

  return { create, destroy, resolve, startSweeper, cookieOptions };
}

export type Sessions = ReturnType<typeof createSessions>;
