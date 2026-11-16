import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';

export class EncryptionKeyError extends Error {
  override name = 'EncryptionKeyError';
}

/** Accepts 32 bytes as base64, base64url, or 64 hex characters. */
export function parseEncryptionKey(raw: string): Buffer {
  const value = raw.trim();
  let key: Buffer | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(value)) key = Buffer.from(value, 'hex');
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) key = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (!key || key.length !== 32) {
    throw new EncryptionKeyError(
      'MAIL_TRIAGE_ENCRYPTION_KEY must be 32 random bytes encoded as base64 or hex (generate with: openssl rand -base64 32)',
    );
  }
  return key;
}

/** Non-secret identifier for the key, used to detect key changes. */
export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update('mail-triage-key-fingerprint').update(key).digest('hex').slice(0, 16);
}

/**
 * AES-256-GCM with the owning record id as associated data, so a ciphertext
 * copied to another account row fails to decrypt.
 */
export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new EncryptionKeyError('Encryption key must be 32 bytes');
  }

  encrypt(plaintext: string, associatedData: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  decrypt(sealed: string, associatedData: string): string {
    const [version, iv, tag, ciphertext] = sealed.split('.');
    if (version !== VERSION || !iv || !tag || ciphertext === undefined) throw new EncryptionKeyError('Unrecognized ciphertext format');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(associatedData, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      throw new EncryptionKeyError('Stored token could not be decrypted; the encryption key may have changed');
    }
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}
