import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { originOf } from './origin.js';
import type { Env } from '../config.js';
import type { Db, SessionUser } from '../db.js';

export const SESSION_COOKIE = 'gamekeep_session';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

const TOUCH_INTERVAL_MS = 60_000;

export function createSessions(env: Env, db: Db) {
  /** When each session was last written, so the write can be skipped. */
  const lastTouched = new Map<string, number>();
  const cookieOptions = {
    httpOnly: true,
    secure: env.PUBLIC_URL.startsWith('https://'),
    // Lax blocks the cookie on cross-site POSTs, which is the CSRF case that
    // matters here since every state-changing route is a POST.
    sameSite: 'lax' as const,
    path: '/',
    signed: true,
  };

  function create(reply: FastifyReply, userId: string, request?: FastifyRequest): string {
    const id = randomBytes(32).toString('base64url');
    db.createSession(id, userId, Date.now() + SESSION_TTL_MS, {
      // Recorded here and never updated: it answers where this session began,
      // which is what makes an unexpected one recognisable.
      ip: request ? originOf(request).ip : null,
      userAgent: request ? originOf(request).userAgent : null,
    });
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

    // At most once a minute: see db.touchSession.
    const now = Date.now();
    const last = lastTouched.get(id) ?? 0;
    if (now - last > TOUCH_INTERVAL_MS) {
      lastTouched.set(id, now);
      db.touchSession(id, now);
    }

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
