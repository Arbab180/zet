import { describe, expect, it } from 'vitest';
import { authorizeRestaurantAccess, type Session } from './authorize';

const NOW = new Date('2026-09-22T12:00:00Z');

function session(overrides: Partial<Session> = {}): Session {
  return { userId: 'user-1', expiresAt: new Date('2026-09-23T00:00:00Z'), ...overrides };
}

describe('authorizeRestaurantAccess', () => {
  it('allows a member with a sufficient role', async () => {
    const result = await authorizeRestaurantAccess({
      session: session(),
      restaurantId: 'anamma',
      now: NOW,
      getRole: async () => 'manager',
    });
    expect(result).toEqual({ allowed: true, role: 'manager' });
  });

  it('denies a user whose membership is for a different restaurant', async () => {
    const result = await authorizeRestaurantAccess({
      session: session(),
      restaurantId: 'anamma',
      now: NOW,
      // this user's only membership is chop_engomi — the lookup for
      // anamma correctly finds nothing
      getRole: async (restaurantId) => (restaurantId === 'chop_engomi' ? 'manager' : null),
    });
    expect(result).toEqual({ allowed: false, reason: 'not_a_member' });
  });

  it('denies with no session', async () => {
    const result = await authorizeRestaurantAccess({
      session: null,
      restaurantId: 'anamma',
      now: NOW,
      getRole: async () => 'manager',
    });
    expect(result).toEqual({ allowed: false, reason: 'no_session' });
  });

  it('denies an expired session', async () => {
    const result = await authorizeRestaurantAccess({
      session: session({ expiresAt: new Date('2026-09-22T11:59:59Z') }),
      restaurantId: 'anamma',
      now: NOW,
      getRole: async () => 'manager',
    });
    expect(result).toEqual({ allowed: false, reason: 'session_expired' });
  });

  it('treats a session expiring at exactly now as expired', async () => {
    const result = await authorizeRestaurantAccess({
      session: session({ expiresAt: NOW }),
      restaurantId: 'anamma',
      now: NOW,
      getRole: async () => 'manager',
    });
    expect(result).toEqual({ allowed: false, reason: 'session_expired' });
  });

  it('denies a read-only viewer trying to write', async () => {
    const result = await authorizeRestaurantAccess({
      session: session(),
      restaurantId: 'anamma',
      now: NOW,
      getRole: async () => 'viewer',
    });
    expect(result).toEqual({ allowed: false, reason: 'insufficient_role' });
  });

  it('allows a viewer read access when only read is required', async () => {
    const result = await authorizeRestaurantAccess({
      session: session(),
      restaurantId: 'anamma',
      minRole: 'read',
      now: NOW,
      getRole: async () => 'viewer',
    });
    expect(result).toEqual({ allowed: true, role: 'viewer' });
  });

  it('rejects an unknown restaurant id without ever calling getRole', async () => {
    let called = false;
    const result = await authorizeRestaurantAccess({
      session: session(),
      restaurantId: 'not-a-real-restaurant',
      now: NOW,
      getRole: async () => {
        called = true;
        return 'manager';
      },
    });
    expect(result).toEqual({ allowed: false, reason: 'invalid_restaurant' });
    expect(called).toBe(false);
  });

  it('fails closed on a role the schema does not recognise', async () => {
    const result = await authorizeRestaurantAccess({
      session: session(),
      restaurantId: 'anamma',
      now: NOW,
      getRole: async () => 'auditor', // not a value restaurant_role has today
    });
    expect(result).toEqual({ allowed: false, reason: 'not_a_member' });
  });
});
