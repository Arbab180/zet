import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, hashPassword, verifyPassword } from './password';

/** Deliberately cheap: these tests check behaviour, not cost. */
const FAST = { N: 1024, r: 8, p: 1 };

describe('hashPassword / verifyPassword', () => {
  it('verifies the right password', async () => {
    const stored = await hashPassword('correct horse battery staple', FAST);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a password differing only in case', async () => {
    const stored = await hashPassword('correct horse battery staple', FAST);
    expect(await verifyPassword('Correct horse battery staple', stored)).toBe(false);
  });

  it('rejects an empty password', async () => {
    const stored = await hashPassword('something', FAST);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('salts: the same password hashes differently every time', async () => {
    expect(await hashPassword('same', FAST)).not.toBe(await hashPassword('same', FAST));
  });

  it('stores its own parameters, so the cost can be raised without invalidating old hashes', async () => {
    const stored = await hashPassword('x', FAST);
    expect(stored.startsWith('scrypt$1024$8$1$')).toBe(true);
    expect(await verifyPassword('x', stored)).toBe(true);
  });

  it('works at the production cost too', async () => {
    const stored = await hashPassword('x', DEFAULT_PARAMS);
    expect(await verifyPassword('x', stored)).toBe(true);
  }, 20_000);

  it('normalises unicode, so the same typed password verifies either way', async () => {
    // "é" composed vs decomposed — different bytes, same password.
    const stored = await hashPassword('café', FAST);
    expect(await verifyPassword('café', stored)).toBe(true);
  });
});

describe('a malformed stored hash reads as "wrong password", never throws', () => {
  const cases: Array<[string, string]> = [
    ['empty string', ''],
    ['not scrypt', 'bcrypt$1$2$3$4$5'],
    ['too few parts', 'scrypt$1024$8$1$abcd'],
    ['non-numeric N', `scrypt$x$8$1$abcd$${'a'.repeat(128)}`],
    ['N not a power of two', `scrypt$1000$8$1$abcd$${'a'.repeat(128)}`],
    ['absurd N — a memory bomb from a tampered env', `scrypt$${1 << 25}$8$1$abcd$${'a'.repeat(128)}`],
    ['wrong hash length', 'scrypt$1024$8$1$abcd$aaaa'],
    ['empty salt', `scrypt$1024$8$1$$${'a'.repeat(128)}`],
    ['garbage', '????'],
  ];

  for (const [name, stored] of cases) {
    it(name, async () => {
      await expect(verifyPassword('anything', stored)).resolves.toBe(false);
    });
  }
});
