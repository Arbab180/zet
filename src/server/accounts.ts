/**
 * Restaurant logins: who is an admin, which restaurants a login belongs
 * to, and the admin's create / reset-password actions.
 *
 * The admin check is made twice, on purpose. Here, so the page can answer
 * "not found" and the action can refuse before hashing anything; and again
 * inside the database (zet_admin_create_login / zet_admin_set_password,
 * migration 0008), which is the check that actually holds — it does not
 * depend on this file being right.
 *
 * Everything posted is validated here with Zod (CLAUDE.md rule 4). The
 * password is hashed here and only the hash ever reaches the database.
 */

import { z } from 'zod';
import { withUserTransaction } from '../lib/db';
import { hashPassword } from '../lib/password';
import type { Session } from '../lib/authorize';
import { FORM_ORDER, type FormId } from '../lib/forms';

/** app_login.session_gen, or null when the user has no restaurant login. */
export async function getSessionGen(userId: string): Promise<number | null> {
  return withUserTransaction(userId, async (client) => {
    const { rows } = await client.query<{ gen: number | null }>(
      'SELECT zet_session_gen($1) AS gen',
      [userId]
    );
    return rows[0]?.gen ?? null;
  });
}

/** Decided by the database from app_user.is_admin, which the app cannot write. */
export async function isAdmin(session: Session | null): Promise<boolean> {
  if (!session) return false;
  return withUserTransaction(session.userId, async (client) => {
    const { rows } = await client.query<{ admin: boolean }>(
      'SELECT zet_caller_is_admin() AS admin'
    );
    return rows[0]?.admin === true;
  });
}

/**
 * The restaurants this login may file a night for, in FORM_ORDER. Read
 * through RLS from restaurant_user, so it is the same membership every save
 * is authorised against — not a separate list that could drift from it.
 */
export async function listWritableRestaurants(userId: string): Promise<FormId[]> {
  const ids = await withUserTransaction(userId, async (client) => {
    const { rows } = await client.query<{ restaurant_id: string }>(
      `SELECT restaurant_id FROM restaurant_user
        WHERE user_id = $1 AND role <> 'viewer'`,
      [userId]
    );
    return new Set(rows.map((r) => r.restaurant_id));
  });
  return FORM_ORDER.filter((id) => ids.has(id));
}

export interface RestaurantLogin {
  userId: string;
  username: string;
  name: string;
  restaurantId: string;
}

/** Every restaurant login the caller can see. For the admin, that is all. */
export async function listRestaurantLogins(userId: string): Promise<RestaurantLogin[]> {
  return withUserTransaction(userId, async (client) => {
    const { rows } = await client.query<{
      id: string;
      username: string;
      name: string;
      restaurant_id: string;
    }>(
      `SELECT u.id, u.username, u.name, ru.restaurant_id
         FROM app_user u
         JOIN restaurant_user ru ON ru.user_id = u.id
        WHERE u.username IS NOT NULL AND NOT u.is_admin
        ORDER BY ru.restaurant_id, u.username`
    );
    return rows.map((r) => ({
      userId: r.id,
      username: r.username,
      name: r.name,
      restaurantId: r.restaurant_id,
    }));
  });
}

// ── Validation ────────────────────────────────────────────────────────────

/** Matches the CHECK on app_user.username (migration 0008). */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const MIN_PASSWORD_LENGTH = 10;

const PasswordPair = z
  .object({
    // Never trimmed: a password is exactly what was typed.
    password: z.string().min(MIN_PASSWORD_LENGTH, 'password_short').max(200, 'password_long'),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { message: 'password_mismatch', path: ['confirm'] });

const CreateLoginFields = z.object({
  restaurantId: z.enum(FORM_ORDER as [FormId, ...FormId[]], {
    errorMap: () => ({ message: 'bad_restaurant' }),
  }),
  username: z
    .string()
    .transform((s) => s.trim().toLowerCase())
    .pipe(z.string().regex(USERNAME_PATTERN, 'bad_username')),
  name: z.string().trim().min(1, 'name_required').max(80, 'name_long'),
});

const ResetPasswordFields = z.object({ userId: z.string().uuid('bad_user') });

export type AccountError =
  | 'not_admin'
  | 'bad_restaurant'
  | 'bad_username'
  | 'reserved_username'
  | 'username_taken'
  | 'already_has_login'
  | 'name_required'
  | 'name_long'
  | 'password_short'
  | 'password_long'
  | 'password_mismatch'
  | 'bad_user'
  | 'failed';

export type AccountResult = { ok: true } | { ok: false; error: AccountError };

const KNOWN_ERRORS = new Set<string>([
  'bad_restaurant', 'bad_username', 'name_required', 'name_long',
  'password_short', 'password_long', 'password_mismatch', 'bad_user',
]);

function firstIssue(error: z.ZodError): AccountError {
  const msg = error.issues[0]?.message ?? '';
  return (KNOWN_ERRORS.has(msg) ? msg : 'failed') as AccountError;
}

export function parseCreateLogin(raw: unknown, adminUsername: string) {
  const fields = CreateLoginFields.safeParse(raw);
  if (!fields.success) return { ok: false as const, error: firstIssue(fields.error) };
  const pw = PasswordPair.safeParse(raw);
  if (!pw.success) return { ok: false as const, error: firstIssue(pw.error) };
  // The admin's name is checked before the database on every login
  // (attemptLogin), so a restaurant login with it could never sign in —
  // and would look, on this page, as if it could.
  if (fields.data.username === adminUsername.trim().toLowerCase()) {
    return { ok: false as const, error: 'reserved_username' as const };
  }
  return { ok: true as const, data: { ...fields.data, password: pw.data.password } };
}

export function parseResetPassword(raw: unknown) {
  const fields = ResetPasswordFields.safeParse(raw);
  if (!fields.success) return { ok: false as const, error: firstIssue(fields.error) };
  const pw = PasswordPair.safeParse(raw);
  if (!pw.success) return { ok: false as const, error: firstIssue(pw.error) };
  return { ok: true as const, data: { userId: fields.data.userId, password: pw.data.password } };
}

function pgCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e
    ? String((e as { code: unknown }).code)
    : undefined;
}

function mapDbError(e: unknown): AccountError {
  switch (pgCode(e)) {
    case 'ZET04': return 'not_admin';
    case 'ZET05': return 'bad_user';
    case 'ZET06': return 'already_has_login';
    case '23505': return 'username_taken';
    case '23514': return 'bad_username';
    default: throw e;
  }
}

// ── Actions ───────────────────────────────────────────────────────────────

export async function createRestaurantLogin(
  session: Session | null,
  raw: unknown,
  adminUsername: string
): Promise<AccountResult> {
  if (!session || !(await isAdmin(session))) return { ok: false, error: 'not_admin' };

  const parsed = parseCreateLogin(raw, adminUsername);
  if (!parsed.ok) return parsed;
  const { restaurantId, username, name, password } = parsed.data;

  const hash = await hashPassword(password);

  try {
    // One login per restaurant is enforced inside the function (ZET06).
    await withUserTransaction(session.userId, (client) =>
      client.query('SELECT zet_admin_create_login($1, $2, $3, $4)', [
        restaurantId,
        username,
        name,
        hash,
      ])
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: mapDbError(e) };
  }
}

export async function resetRestaurantPassword(
  session: Session | null,
  raw: unknown
): Promise<AccountResult> {
  if (!session || !(await isAdmin(session))) return { ok: false, error: 'not_admin' };

  const parsed = parseResetPassword(raw);
  if (!parsed.ok) return parsed;
  const { userId, password } = parsed.data;

  const hash = await hashPassword(password);

  try {
    await withUserTransaction(session.userId, (client) =>
      client.query('SELECT zet_admin_set_password($1, $2)', [userId, hash])
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: mapDbError(e) };
  }
}
