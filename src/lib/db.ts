/**
 * The only way any server code may talk to Postgres.
 *
 * Two things this module exists to make structurally impossible, not just
 * documented:
 *
 * 1. Running a query as a role that can bypass row-level security. RLS
 *    (db/migrations/0002_harden_reports.sql) is the floor that stops one
 *    restaurant reading another's takings once a second consumer (the AI
 *    invoicing project) reads this database directly — see that
 *    migration's header. A connection made as a superuser, a BYPASSRLS
 *    role, or the role that owns the tables skips RLS silently. This
 *    module refuses to serve a single query until it has confirmed the
 *    connecting role is none of those.
 *
 * 2. Running a query with zet.user_id unset. Every RLS policy in this
 *    schema keys off that session GUC (see zet_visible_restaurants() in
 *    0002). With it unset, every restaurant-scoped table returns zero
 *    rows — not an error. A forgotten SET LOCAL looks exactly like "this
 *    restaurant has no reports yet." withUserTransaction is the ONLY
 *    exported way to get a client, and it sets and verifies zet.user_id
 *    before running the caller's code — there is deliberately no exported
 *    `pool` or raw-client accessor, so there is no code path in this
 *    codebase that can query the database unscoped.
 */

import { Pool, type PoolClient } from 'pg';

// Sized for hosting: up to two app instances (apphosting.yaml) × 5 is well
// inside a small Neon database's connection limit. Idle connections close
// after 10s so the database can go to sleep between uses; the connect
// timeout allows for it waking up (about a second on Neon).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 15_000,
});

export class UnsafeConnectionError extends Error {}
export class MissingSessionScopeError extends Error {}

let roleSafetyConfirmed = false;

/**
 * Runs once per process (cached), not once per query: every connection in
 * this pool shares the same connection string, so the role is the same
 * for all of them.
 */
async function assertConnectionRoleIsSafe(client: PoolClient): Promise<void> {
  if (roleSafetyConfirmed) return;

  const { rows: roleRows } = await client.query<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>('SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');

  const role = roleRows[0];
  if (!role) {
    throw new UnsafeConnectionError('could not determine the connecting Postgres role');
  }
  if (role.rolsuper) {
    throw new UnsafeConnectionError(
      `refusing to serve requests as superuser "${role.rolname}" — row-level security is bypassed for superusers, so restaurant authorisation would silently do nothing`
    );
  }
  if (role.rolbypassrls) {
    throw new UnsafeConnectionError(
      `refusing to serve requests as role "${role.rolname}", which has BYPASSRLS — row-level security would silently do nothing for every request`
    );
  }

  const { rows: ownerRows } = await client.query<{ owner: string | null }>(
    "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = 'zet_report'"
  );
  if (ownerRows[0]?.owner === role.rolname) {
    throw new UnsafeConnectionError(
      `refusing to serve requests as role "${role.rolname}", which owns zet_report — table owners bypass row-level security by default (see the RLS note in db/migrations/0002_harden_reports.sql)`
    );
  }

  roleSafetyConfirmed = true;
}

/**
 * The only entry point for a database query. Opens a transaction, sets
 * zet.user_id from an already-authenticated user id, verifies it actually
 * took effect, then hands the caller a client scoped to that user for the
 * rest of the transaction. Commits on success, rolls back on any error.
 *
 * userId must already be authenticated by the caller — this function does
 * not check a session, it only refuses to run anything if userId is
 * empty. Authorisation for a specific restaurant is a separate, explicit
 * check (see authorizeRestaurantAccess in src/lib/authorize.ts); RLS here
 * is the floor underneath that, not a replacement for it.
 */
export async function withUserTransaction<T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  if (!userId) {
    throw new MissingSessionScopeError(
      'withUserTransaction called with no userId — refusing to run a query with row-level security unscoped, since an unscoped query returns an empty result set instead of an error'
    );
  }

  const client = await pool.connect();
  try {
    await assertConnectionRoleIsSafe(client);
    await client.query('BEGIN');
    await client.query("SELECT set_config('zet.user_id', $1, true)", [userId]);

    const { rows } = await client.query<{ uid: string | null }>(
      "SELECT current_setting('zet.user_id', true) AS uid"
    );
    if (rows[0]?.uid !== userId) {
      throw new MissingSessionScopeError(
        `zet.user_id did not take effect on this transaction (expected "${userId}", got "${rows[0]?.uid ?? 'null'}") — refusing to run a query that row-level security would silently empty instead of rejecting`
      );
    }

    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A user's role for one restaurant, or null if they are not a member of
 * it — the data authorizeRestaurantAccess needs to make its decision.
 * Kept separate from that function so the authorisation logic itself
 * stays a pure, DB-free function that unit tests can call directly.
 *
 * Two shapes:
 *
 * - getRestaurantRole(userId, restaurantId) opens its own transaction via
 *   withUserTransaction. Fine for a standalone lookup — a health check, a
 *   page that only reads.
 * - getRestaurantRole(client, userId, restaurantId) runs on a client the
 *   caller already has open. Use this inside a server action that must
 *   authorise and then write in the SAME transaction: calling the
 *   standalone version from inside an already-open withUserTransaction
 *   would acquire a second pool connection per request, and every
 *   concurrent request doing that is one step from exhausting the pool
 *   and deadlocking it (each request holding one connection while
 *   waiting on a second that never frees up).
 */
export function getRestaurantRole(userId: string, restaurantId: string): Promise<string | null>;
export function getRestaurantRole(
  client: PoolClient,
  userId: string,
  restaurantId: string
): Promise<string | null>;
export async function getRestaurantRole(
  clientOrUserId: PoolClient | string,
  userIdOrRestaurantId: string,
  maybeRestaurantId?: string
): Promise<string | null> {
  if (typeof clientOrUserId === 'string') {
    const userId = clientOrUserId;
    const restaurantId = userIdOrRestaurantId;
    return withUserTransaction(userId, (client) => selectRestaurantRole(client, userId, restaurantId));
  }

  const client = clientOrUserId;
  const userId = userIdOrRestaurantId;
  if (maybeRestaurantId === undefined) {
    throw new MissingSessionScopeError(
      'getRestaurantRole(client, userId, restaurantId) called without restaurantId'
    );
  }
  return selectRestaurantRole(client, userId, maybeRestaurantId);
}

/**
 * The actual query, shared by both shapes above. Defensively re-checks
 * that the client handed to the (client, userId, restaurantId) overload
 * is really scoped to the userId being asked about — a client passed in
 * from a different user's withUserTransaction call would otherwise look
 * up the right restaurant_id under the WRONG zet.user_id, silently
 * returning null (not a member) instead of failing loudly on the mistake
 * that caused it.
 */
async function selectRestaurantRole(
  client: PoolClient,
  userId: string,
  restaurantId: string
): Promise<string | null> {
  const { rows: scopeRows } = await client.query<{ uid: string | null }>(
    "SELECT current_setting('zet.user_id', true) AS uid"
  );
  if (scopeRows[0]?.uid !== userId) {
    throw new MissingSessionScopeError(
      `getRestaurantRole called for userId "${userId}" but this client's transaction is scoped to zet.user_id "${scopeRows[0]?.uid ?? 'null'}" — pass the client from that same user's withUserTransaction call`
    );
  }

  const { rows } = await client.query<{ role: string }>(
    'SELECT role FROM restaurant_user WHERE restaurant_id = $1 AND user_id = $2',
    [restaurantId, userId]
  );
  return rows[0]?.role ?? null;
}

export interface LoginRecord {
  userId: string;
  passwordHash: string;
  sessionGen: number;
}

/**
 * The single exception to "every query runs scoped to a user": a login
 * attempt happens before there is a user. It is deliberately not a general
 * unscoped client — it can do exactly one thing, call zet_login_lookup
 * (migration 0008), which answers for the one username asked about and
 * nothing else. The hashes table itself has no grant to this role at all.
 *
 * The role-safety check still runs first, as for every other query.
 */
export async function lookupLogin(username: string): Promise<LoginRecord | null> {
  const client = await pool.connect();
  try {
    await assertConnectionRoleIsSafe(client);
    const { rows } = await client.query<{
      user_id: string;
      password_hash: string;
      session_gen: number;
    }>('SELECT user_id, password_hash, session_gen FROM zet_login_lookup($1)', [username]);
    const row = rows[0];
    if (!row) return null;
    return { userId: row.user_id, passwordHash: row.password_hash, sessionGen: row.session_gen };
  } finally {
    client.release();
  }
}
