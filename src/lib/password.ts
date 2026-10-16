/**
 * Password hashing and verification, using node:crypto's scrypt — no new
 * dependency, and scrypt is deliberately slow and memory-hard, so a stolen
 * hash is expensive to attack offline.
 *
 * The stored form is `scrypt$N$r$p$<salt-hex>$<hash-hex>`. Parameters are
 * stored ALONGSIDE the hash rather than assumed, so raising the cost later
 * does not invalidate every existing hash — an old hash keeps verifying
 * with the parameters it was made with.
 *
 * Comparison is timing-safe. A plain === on a hash leaks how many leading
 * bytes matched, which is enough to recover it byte by byte given enough
 * attempts.
 *
 * This module is pure and takes no environment: whoever calls it supplies
 * the stored hash. That is what makes it testable without a running app.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

const KEY_LENGTH = 64;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** Cost for new hashes. N=2^15 keeps a single verification around 100ms. */
export const DEFAULT_PARAMS: ScryptParams = { N: 32768, r: 8, p: 1 };

function maxmemFor(p: ScryptParams): number {
  // node's default maxmem (32MB) is below what N=32768, r=8 needs.
  return 256 * p.N * p.r * 2;
}

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_PARAMS,
  salt: Buffer = randomBytes(16)
): Promise<string> {
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    ...params,
    maxmem: maxmemFor(params),
  });
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * False for a wrong password AND for a malformed or empty stored hash.
 * Never throws: a broken ADMIN_PASSWORD_HASH must read as "wrong password"
 * and keep everyone out, not crash the login route into a 500 that some
 * error handler might mistake for something else.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    if (N <= 1 || (N & (N - 1)) !== 0 || r < 1 || p < 1) return false;
    // Refuse absurd parameters from a tampered env rather than letting a
    // login request allocate gigabytes.
    if (N > 1 << 20 || r > 32 || p > 16) return false;

    const salt = Buffer.from(parts[4]!, 'hex');
    const expected = Buffer.from(parts[5]!, 'hex');
    if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;

    const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
      N,
      r,
      p,
      maxmem: maxmemFor({ N, r, p }),
    });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
