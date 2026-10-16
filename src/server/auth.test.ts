import { beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../lib/password';
import {
  attemptLogin,
  readAdminConfig,
  resetLoginThrottle,
  resolveSession,
  sessionFromToken,
  type AdminConfig,
  type LoginLookup,
} from './auth';

const FAST = { N: 1024, r: 8, p: 1 };

async function config(over: Partial<AdminConfig> = {}): Promise<AdminConfig> {
  return {
    username: 'admin',
    passwordHash: await hashPassword('a good long passphrase', FAST),
    userId: '11111111-1111-1111-1111-111111111111',
    sessionSecret: 'test-secret',
    ...over,
  };
}

beforeEach(() => resetLoginThrottle());

describe('readAdminConfig', () => {
  const full = {
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD_HASH: 'scrypt$1$1$1$a$b',
    ADMIN_USER_ID: 'u',
    SESSION_SECRET: 's',
  };

  it('reads a complete environment', () => {
    expect(readAdminConfig(full)).not.toBeNull();
  });

  for (const key of Object.keys(full)) {
    it(`returns null when ${key} is missing — login fails closed, never open`, () => {
      const partial = { ...full, [key]: '' };
      expect(readAdminConfig(partial)).toBeNull();
    });
  }

  // What Next.js leaves of an unescaped hash after `$` expansion.
  for (const mangled of ['scrypt', 'scrypt$$$$$', 'bcrypt$1$1$1$a$b']) {
    it(`returns null for a malformed hash (${mangled}) — says not configured, not wrong password`, () => {
      expect(readAdminConfig({ ...full, ADMIN_PASSWORD_HASH: mangled })).toBeNull();
    });
  }
});

describe('attemptLogin', () => {
  it('accepts the right credentials and issues a readable session', async () => {
    const c = await config();
    const result = await attemptLogin('admin', 'a good long passphrase', c);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sessionFromToken(result.token, c)?.userId).toBe(c.userId);
  });

  it('rejects a wrong password', async () => {
    const r = await attemptLogin('admin', 'wrong', await config());
    expect(r).toEqual({ ok: false, reason: 'bad_credentials' });
  });

  it('gives the SAME reason for a wrong username, so usernames cannot be enumerated', async () => {
    const c = await config();
    const wrongUser = await attemptLogin('nobody', 'a good long passphrase', c);
    const wrongPass = await attemptLogin('admin', 'nope', c);
    expect(wrongUser).toEqual(wrongPass);
  });

  it('refuses everything when the app is not configured', async () => {
    expect(await attemptLogin('admin', 'anything', null)).toEqual({
      ok: false,
      reason: 'not_configured',
    });
  });

  it('slows down once SLOW_AFTER_ATTEMPTS failures have happened, not one later', async () => {
    const c = await config();
    for (let i = 0; i < 5; i++) await attemptLogin('admin', 'wrong', c);
    const started = Date.now();
    await attemptLogin('admin', 'wrong', c);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  }, 20_000);

  it('clears the penalty on a successful login', async () => {
    const c = await config();
    for (let i = 0; i < 8; i++) await attemptLogin('admin', 'wrong', c);
    await attemptLogin('admin', 'a good long passphrase', c);
    const started = Date.now();
    await attemptLogin('admin', 'wrong', c);
    expect(Date.now() - started).toBeLessThan(200);
  }, 20_000);

  it('trims the typed username but never the password', async () => {
    const c = await config();
    expect((await attemptLogin('  admin  ', 'a good long passphrase', c)).ok).toBe(true);
    expect((await attemptLogin('admin', ' a good long passphrase ', c)).ok).toBe(false);
  });
});

describe('sessionFromToken', () => {
  it('returns null for no cookie', async () => {
    expect(sessionFromToken(undefined, await config())).toBeNull();
  });

  it('returns null when the app is not configured, even with a real-looking token', async () => {
    const c = await config();
    const result = await attemptLogin('admin', 'a good long passphrase', c);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sessionFromToken(result.token, null)).toBeNull();
  });

  it('returns null for a token signed with a different secret', async () => {
    const c = await config();
    const result = await attemptLogin('admin', 'a good long passphrase', c);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sessionFromToken(result.token, { ...c, sessionSecret: 'other' })).toBeNull();
  });

  it('returns null once the session has expired', async () => {
    const c = await config();
    const result = await attemptLogin('admin', 'a good long passphrase', c);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = new Date(result.expiresAt + 1);
    expect(sessionFromToken(result.token, c, after)).toBeNull();
  });
});

// ── Restaurant logins ─────────────────────────────────────────────────────

const ANAMMA_ID = '22222222-2222-2222-2222-222222222222';

async function anammaLookup(gen = 3): Promise<LoginLookup> {
  const passwordHash = await hashPassword('anamma night shift', FAST);
  return async (username) =>
    username.toLowerCase() === 'anamma' ? { userId: ANAMMA_ID, passwordHash, sessionGen: gen } : null;
}

describe('attemptLogin — restaurant logins from the database', () => {
  it('signs a restaurant in as its own user, carrying its session generation', async () => {
    const c = await config();
    const r = await attemptLogin('anamma', 'anamma night shift', c, await anammaLookup(3));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const claim = sessionFromToken(r.token, c);
    expect(claim?.userId).toBe(ANAMMA_ID);
    expect(claim?.gen).toBe(3);
  });

  it('the admin is still the environment login and gets generation 0', async () => {
    const c = await config();
    const r = await attemptLogin('admin', 'a good long passphrase', c, await anammaLookup());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(sessionFromToken(r.token, c)).toMatchObject({ userId: c.userId, gen: 0 });
  });

  it('never asks the database about the admin username', async () => {
    const c = await config();
    let asked = false;
    const lookup: LoginLookup = async () => {
      asked = true;
      return null;
    };
    await attemptLogin('admin', 'wrong', c, lookup);
    expect(asked).toBe(false);
  });

  it('a restaurant password does not open the admin, nor the admin password a restaurant', async () => {
    const c = await config();
    const lookup = await anammaLookup();
    expect((await attemptLogin('admin', 'anamma night shift', c, lookup)).ok).toBe(false);
    expect((await attemptLogin('anamma', 'a good long passphrase', c, lookup)).ok).toBe(false);
  });

  it('unknown username and wrong password look identical', async () => {
    const c = await config();
    const lookup = await anammaLookup();
    expect(await attemptLogin('nobody', 'anamma night shift', c, lookup)).toEqual(
      await attemptLogin('anamma', 'wrong', c, lookup)
    );
  });

  it('says "unavailable", not "wrong password", when the database cannot be asked', async () => {
    const c = await config();
    const broken: LoginLookup = async () => {
      throw new Error('connection refused');
    };
    expect(await attemptLogin('anamma', 'anamma night shift', c, broken)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it("refuses a database row that claims the admin's id or generation 0", async () => {
    const c = await config();
    const passwordHash = await hashPassword('anamma night shift', FAST);
    const asAdmin: LoginLookup = async () => ({ userId: c.userId, passwordHash, sessionGen: 1 });
    const genZero: LoginLookup = async () => ({ userId: ANAMMA_ID, passwordHash, sessionGen: 0 });
    expect((await attemptLogin('anamma', 'anamma night shift', c, asAdmin)).ok).toBe(false);
    expect((await attemptLogin('anamma', 'anamma night shift', c, genZero)).ok).toBe(false);
  });

  it('throttles guesses sent all at once, not only one after another', async () => {
    const c = await config();
    const started = Date.now();
    await Promise.all(Array.from({ length: 8 }, () => attemptLogin('admin', 'wrong', c)));
    // The 6th, 7th and 8th must each have waited (100 + 200 + 400 ms at
    // most in parallel, so at least the longest of them).
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  }, 20_000);

  it("one restaurant's failed attempts do not slow another login down", async () => {
    const c = await config();
    const lookup = await anammaLookup();
    for (let i = 0; i < 8; i++) await attemptLogin('anamma', 'wrong', c, lookup);
    const started = Date.now();
    await attemptLogin('admin', 'wrong', c, lookup);
    expect(Date.now() - started).toBeLessThan(200);
  }, 20_000);
});

describe('resolveSession — re-checked on every request', () => {
  async function tokenFor(username: string, password: string, c: AdminConfig, lookup: LoginLookup) {
    const r = await attemptLogin(username, password, c, lookup);
    if (!r.ok) throw new Error('login failed in test setup');
    return r.token;
  }

  it('accepts the admin without asking the database', async () => {
    const c = await config();
    const token = await tokenFor('admin', 'a good long passphrase', c, await anammaLookup());
    const s = await resolveSession(token, c, async () => {
      throw new Error('must not be called');
    });
    expect(s?.userId).toBe(c.userId);
  });

  it('accepts a restaurant login whose generation is still current', async () => {
    const c = await config();
    const token = await tokenFor('anamma', 'anamma night shift', c, await anammaLookup(3));
    expect((await resolveSession(token, c, async () => 3))?.userId).toBe(ANAMMA_ID);
  });

  it('signs a restaurant out once its password has been reset (generation moved on)', async () => {
    const c = await config();
    const token = await tokenFor('anamma', 'anamma night shift', c, await anammaLookup(3));
    expect(await resolveSession(token, c, async () => 4)).toBeNull();
  });

  it('signs a restaurant out when its login no longer exists', async () => {
    const c = await config();
    const token = await tokenFor('anamma', 'anamma night shift', c, await anammaLookup(3));
    expect(await resolveSession(token, c, async () => null)).toBeNull();
  });

  it('treats an unreachable database as signed out, not signed in', async () => {
    const c = await config();
    const token = await tokenFor('anamma', 'anamma night shift', c, await anammaLookup(3));
    const broken = async () => {
      throw new Error('down');
    };
    expect(await resolveSession(token, c, broken)).toBeNull();
  });

  it('an admin token stops working if ADMIN_USER_ID changes', async () => {
    const c = await config();
    const token = await tokenFor('admin', 'a good long passphrase', c, await anammaLookup());
    const moved = { ...c, userId: '33333333-3333-3333-3333-333333333333' };
    expect(await resolveSession(token, moved, async () => 1)).toBeNull();
  });
});
