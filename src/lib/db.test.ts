/**
 * db.ts talks to Postgres, so these tests mock the `pg` module entirely —
 * no live database required, same as the rest of this suite. What's under
 * test is control flow, not SQL correctness: does the right code path
 * acquire a connection, does it read the safety/scope checks back
 * correctly, does it release the client on both success and failure.
 *
 * Each test re-imports db.ts fresh (vi.resetModules + dynamic import)
 * because assertConnectionRoleIsSafe caches its result in a module-level
 * variable — without a fresh module per test, only the first test to
 * exercise that check would actually run it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

const mockConnect = vi.fn();

vi.mock('pg', () => ({
  // A function, not an arrow: db.ts calls `new Pool(...)`, and since
  // vitest 4 a mock is only constructible if its implementation is.
  Pool: vi.fn().mockImplementation(function () {
    return { connect: mockConnect };
  }),
}));

function makeMockClient(overrides: {
  rolsuper?: boolean;
  rolbypassrls?: boolean;
  owner?: string | null;
  scopedUserId?: string | null;
} = {}) {
  const { rolsuper = false, rolbypassrls = false, owner = 'zet_owner', scopedUserId = null } =
    overrides;
  // zet.user_id starts unset (null) and becomes whatever the code SETs,
  // mirroring a real session GUC for the lifetime of this fake client.
  let currentUserId = scopedUserId;

  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('pg_roles')) {
      return { rows: [{ rolname: 'zet_app', rolsuper, rolbypassrls }] };
    }
    if (sql.includes('pg_class')) {
      return { rows: [{ owner }] };
    }
    if (sql.includes('set_config')) {
      currentUserId = (params?.[0] as string | undefined) ?? null;
      return { rows: [] };
    }
    if (sql.includes('current_setting')) {
      return { rows: [{ uid: currentUserId }] };
    }
    if (sql.includes('SELECT role FROM restaurant_user')) {
      return { rows: [{ role: 'manager' }] };
    }
    return { rows: [] }; // BEGIN, COMMIT, ROLLBACK
  });

  return { query, release: vi.fn() };
}

async function freshDb() {
  vi.resetModules();
  return import('./db');
}

beforeEach(() => {
  mockConnect.mockReset();
});

describe('getRestaurantRole(client, userId, restaurantId)', () => {
  it('does not acquire a second connection when given an existing client', async () => {
    const { getRestaurantRole } = await freshDb();
    const client = makeMockClient({ scopedUserId: 'user-1' });

    const role = await getRestaurantRole(client as unknown as PoolClient, 'user-1', 'anamma');

    expect(role).toBe('manager');
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('throws instead of silently querying under the wrong scope', async () => {
    const { getRestaurantRole, MissingSessionScopeError } = await freshDb();
    // this client's transaction is scoped to a DIFFERENT user
    const client = makeMockClient({ scopedUserId: 'someone-else' });

    await expect(
      getRestaurantRole(client as unknown as PoolClient, 'user-1', 'anamma')
    ).rejects.toBeInstanceOf(MissingSessionScopeError);
    expect(mockConnect).not.toHaveBeenCalled();
  });
});

describe('getRestaurantRole(userId, restaurantId)', () => {
  it('acquires its own connection', async () => {
    const { getRestaurantRole } = await freshDb();
    const client = makeMockClient();
    mockConnect.mockResolvedValue(client);

    const role = await getRestaurantRole('user-1', 'anamma');

    expect(role).toBe('manager');
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });
});

describe('withUserTransaction', () => {
  it('rejects an empty userId without acquiring a connection', async () => {
    const { withUserTransaction, MissingSessionScopeError } = await freshDb();

    await expect(withUserTransaction('', async () => 'never')).rejects.toBeInstanceOf(
      MissingSessionScopeError
    );
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('rolls back and releases the client when the callback throws', async () => {
    const { withUserTransaction } = await freshDb();
    const client = makeMockClient();
    mockConnect.mockResolvedValue(client);

    await expect(
      withUserTransaction('user-1', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a superuser', { rolsuper: true }],
    ['a role with BYPASSRLS', { rolbypassrls: true }],
    ['the role that owns zet_report', { owner: 'zet_app' }],
  ])('refuses to run as %s', async (_label, overrides) => {
    const { withUserTransaction, UnsafeConnectionError } = await freshDb();
    const client = makeMockClient(overrides);
    mockConnect.mockResolvedValue(client);

    await expect(withUserTransaction('user-1', async () => 'never')).rejects.toBeInstanceOf(
      UnsafeConnectionError
    );
  });
});
