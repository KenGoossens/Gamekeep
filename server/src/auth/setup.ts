import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db.js';

/**
 * Guards creation of the very first account.
 *
 * Before any user exists the portal has nothing to authenticate against, so the
 * setup page would otherwise hand admin to whoever loads it first. Instead a
 * one-time token is generated at boot and printed to the container log: you
 * need access to the server's logs to claim the admin account, not merely
 * access to the URL.
 *
 * The token lives in memory only. A restart mints a fresh one and prints it
 * again, which is fine -- and means nothing sensitive is left on disk.
 */
export function createSetupGuard(db: Db) {
  let token: string | null = null;

  function needsSetup(): boolean {
    return db.userCount() === 0;
  }

  /** Called at boot; returns the token to print, or null if setup is done. */
  function begin(): string | null {
    if (!needsSetup()) {
      token = null;
      return null;
    }
    token = randomBytes(24).toString('base64url');
    return token;
  }

  function verify(candidate: unknown): boolean {
    if (!token || typeof candidate !== 'string') return false;
    const a = Buffer.from(token);
    const b = Buffer.from(candidate);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Burns the token once the first admin exists. */
  function complete() {
    token = null;
  }

  return { needsSetup, begin, verify, complete };
}

export type SetupGuard = ReturnType<typeof createSetupGuard>;
