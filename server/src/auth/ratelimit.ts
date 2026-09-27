/**
 * In-memory throttle for failed logins. Keyed by username AND by client IP:
 * the first stops someone grinding away at one account, the second stops a
 * spray across many usernames from one source.
 *
 * Deliberately not persisted. A restart clearing the counters is an acceptable
 * trade for having no moving parts, and the window is short anyway.
 */
const MAX_FAILURES = 8;
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

interface Bucket {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
}

export function createLoginThrottle() {
  const buckets = new Map<string, Bucket>();

  function prune(now: number) {
    for (const [key, b] of buckets) {
      if (b.lockedUntil < now && now - b.firstFailureAt > WINDOW_MS) buckets.delete(key);
    }
  }

  /** Seconds remaining if locked out, or 0 when the attempt may proceed. */
  function retryAfter(keys: string[]): number {
    const now = Date.now();
    let longest = 0;
    for (const key of keys) {
      const bucket = buckets.get(key);
      if (bucket && bucket.lockedUntil > now) {
        longest = Math.max(longest, Math.ceil((bucket.lockedUntil - now) / 1000));
      }
    }
    return longest;
  }

  function recordFailure(keys: string[]) {
    const now = Date.now();
    prune(now);
    for (const key of keys) {
      const bucket = buckets.get(key);
      if (!bucket || now - bucket.firstFailureAt > WINDOW_MS) {
        buckets.set(key, { failures: 1, firstFailureAt: now, lockedUntil: 0 });
        continue;
      }
      bucket.failures += 1;
      if (bucket.failures >= MAX_FAILURES) {
        bucket.lockedUntil = now + LOCKOUT_MS;
        bucket.failures = 0;
        bucket.firstFailureAt = now;
      }
    }
  }

  function clear(keys: string[]) {
    for (const key of keys) buckets.delete(key);
  }

  return { retryAfter, recordFailure, clear };
}

export type LoginThrottle = ReturnType<typeof createLoginThrottle>;
