import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt from node:crypto -- deliberately not bcrypt or argon2, both of which
 * are native modules. Keeping the dependency list free of anything that needs
 * compiling is why this app installs cleanly on Alpine and on Windows alike.
 */
const COST_N = 16384;
const BLOCK_R = 8;
const PARALLEL_P = 1;
const KEY_LENGTH = 64;
const MAXMEM = 64 * 1024 * 1024;

/** Long enough to matter on an internet-facing portal, short enough to type. */
export const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;

export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string') return 'Password is required.';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return 'Password is too long.';
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scryptAsync(password, salt, KEY_LENGTH, {
    N: COST_N,
    r: BLOCK_R,
    p: PARALLEL_P,
    maxmem: MAXMEM,
  })) as Buffer;

  return ['scrypt', COST_N, BLOCK_R, PARALLEL_P, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Constant-time, and never throws on a malformed stored value. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  try {
    const salt = Buffer.from(parts[4] ?? '', 'base64');
    const expected = Buffer.from(parts[5] ?? '', 'base64');
    if (salt.length === 0 || expected.length === 0) return false;

    const key = (await scryptAsync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAXMEM,
    })) as Buffer;

    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// Ambiguous characters removed: these passwords get read aloud and retyped.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function generateTempPassword(length = 16): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/;

export function validateUsername(username: unknown): string | null {
  if (typeof username !== 'string' || username.length === 0) return 'Username is required.';
  if (!USERNAME_PATTERN.test(username)) {
    return 'Username must be 2-32 characters: letters, digits, and . _ - (starting with a letter or digit).';
  }
  return null;
}
