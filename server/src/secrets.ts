import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Encrypts integration credentials at rest.
 *
 * A UniFi key that can write firewall rules should not sit in plain text in a
 * database that gets backed up to the array. The key is derived from
 * SESSION_SECRET, which already has to be protected and is not in the database
 * -- so a stolen copy of gamekeep.db alone reveals nothing.
 */
const ALGORITHM = 'aes-256-gcm';

function keyFrom(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), 'gamekeep-secrets', 32));
}

export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export function decryptSecret(stored: string, secret: string): string | null {
  const [ivB64, tagB64, bodyB64] = stored.split('.');
  if (!ivB64 || !tagB64 || !bodyB64) return null;

  try {
    const decipher = createDecipheriv(ALGORITHM, keyFrom(secret), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(bodyB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong secret or tampered value: treat as absent rather than throwing.
    return null;
  }
}
