import { describe, expect, it } from 'vitest';
import { SESSION_TTL_MS, createSessionToken, readSessionToken } from './session';

const SECRET = 'a-test-secret-value';
const NOW = new Date('2026-09-24T20:00:00Z');

function freshToken(userId = 'user-1') {
  return createSessionToken({ userId, expiresAt: NOW.getTime() + SESSION_TTL_MS, gen: 1 }, SECRET);
}

describe('createSessionToken / readSessionToken', () => {
  it('round-trips the user id', () => {
    expect(readSessionToken(freshToken(), SECRET, NOW)?.userId).toBe('user-1');
  });

  it('round-trips the session generation', () => {
    expect(readSessionToken(freshToken(), SECRET, NOW)?.gen).toBe(1);
  });

  it('refuses to sign with an empty secret rather than producing a forgeable token', () => {
    expect(() => createSessionToken({ userId: 'x', expiresAt: 1, gen: 1 }, '')).toThrow();
  });
});

describe('readSessionToken returns null — not a session — for', () => {
  it('a token signed with a different secret', () => {
    expect(readSessionToken(freshToken(), 'another-secret', NOW)).toBeNull();
  });

  it('a tampered payload: swapping in a different user keeps the old signature', () => {
    const token = freshToken();
    const forgedBody = Buffer.from(
      JSON.stringify({ userId: 'admin', expiresAt: NOW.getTime() + 1e9 }),
      'utf8'
    ).toString('base64url');
    expect(readSessionToken(`${forgedBody}.${token.split('.')[1]}`, SECRET, NOW)).toBeNull();
  });

  it('an expired token', () => {
    const later = new Date(NOW.getTime() + SESSION_TTL_MS + 1);
    expect(readSessionToken(freshToken(), SECRET, later)).toBeNull();
  });

  it('a token that expires exactly now', () => {
    const token = createSessionToken({ userId: 'u', expiresAt: NOW.getTime(), gen: 1 }, SECRET);
    expect(readSessionToken(token, SECRET, NOW)).toBeNull();
  });

  it('an unsigned body', () => {
    expect(readSessionToken(freshToken().split('.')[0]!, SECRET, NOW)).toBeNull();
  });

  it('a signature of a different length', () => {
    expect(readSessionToken(`${freshToken().split('.')[0]}.short`, SECRET, NOW)).toBeNull();
  });

  it('undefined, null and empty', () => {
    expect(readSessionToken(undefined, SECRET, NOW)).toBeNull();
    expect(readSessionToken(null, SECRET, NOW)).toBeNull();
    expect(readSessionToken('', SECRET, NOW)).toBeNull();
  });

  it('an empty secret — a missing SESSION_SECRET must lock everyone out, not let everyone in', () => {
    expect(readSessionToken(freshToken(), '', NOW)).toBeNull();
  });

  it('garbage', () => {
    expect(readSessionToken('....', SECRET, NOW)).toBeNull();
    expect(readSessionToken('no-dot-here', SECRET, NOW)).toBeNull();
  });

  it('a validly signed body that is not a session object', () => {
    // Signed with the real secret, so only the payload check can catch it.
    const body = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8').toString('base64url');
    const token = createSessionToken({ userId: 'x', expiresAt: 1, gen: 1 }, SECRET);
    void token;
    expect(readSessionToken(`${body}.whatever`, SECRET, NOW)).toBeNull();
  });

  // Every cookie issued before restaurant logins existed looks like this:
  // correctly signed, unexpired, and no `gen`. It must not survive the
  // deploy — it cannot say whether the admin or a restaurant issued it.
  it('a correctly signed token from before session generations existed', () => {
    const legacy = { userId: 'admin-id', expiresAt: NOW.getTime() + SESSION_TTL_MS };
    const token = createSessionToken(legacy as never, SECRET);
    expect(readSessionToken(token, SECRET, NOW)).toBeNull();
  });

  it('a negative or fractional generation', () => {
    for (const gen of [-1, 1.5]) {
      const token = createSessionToken({ userId: 'u', expiresAt: NOW.getTime() + 1000, gen }, SECRET);
      expect(readSessionToken(token, SECRET, NOW)).toBeNull();
    }
  });
});
