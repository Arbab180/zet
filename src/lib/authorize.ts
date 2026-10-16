/**
 * Per-restaurant authorisation. CLAUDE.md rule 3: every request re-checks
 * that this user may act on this restaurant — not once at login, not
 * cached from a prior request. Call this fresh, every time.
 *
 * This function is deliberately DB-free: it takes a `getRole` lookup as a
 * parameter instead of querying Postgres itself, so the decision logic —
 * the part actually worth testing — is a pure function with no live
 * database required. The lookup itself (src/lib/db.ts's
 * getRestaurantRole) always runs inside withUserTransaction, which is the
 * only way this codebase can reach the database at all.
 *
 * `Session` is deliberately minimal: userId + expiresAt is all this check
 * needs. Producing a Session (login, cookies, whatever mechanism) is a
 * separate concern this module does not take a position on.
 */

import { z } from 'zod';
import { FORM_ORDER, type FormId } from './forms';

export type Role = 'staff' | 'manager' | 'admin' | 'viewer';

export interface Session {
  userId: string;
  expiresAt: Date;
}

export type AuthzDecision =
  | { allowed: true; role: Role }
  | {
      allowed: false;
      reason:
        | 'no_session'
        | 'session_expired'
        | 'invalid_restaurant'
        | 'not_a_member'
        | 'insufficient_role';
    };

const RestaurantIdSchema = z.enum(FORM_ORDER as [FormId, ...FormId[]]);
const RoleSchema = z.enum(['staff', 'manager', 'admin', 'viewer']);

export interface AuthorizeRestaurantAccessInput {
  session: Session | null;
  restaurantId: string;
  /** 'write' (default) requires staff/manager/admin. 'read' also allows viewer. */
  minRole?: 'read' | 'write';
  /** Injectable for tests; defaults to real time. */
  now?: Date;
  /** Looks up this user's role for this restaurant, or null if not a member. */
  getRole: (restaurantId: FormId, userId: string) => Promise<string | null>;
}

export async function authorizeRestaurantAccess(
  input: AuthorizeRestaurantAccessInput
): Promise<AuthzDecision> {
  const { session, getRole } = input;
  const minRole = input.minRole ?? 'write';
  const now = input.now ?? new Date();

  if (!session) {
    return { allowed: false, reason: 'no_session' };
  }
  if (session.expiresAt.getTime() <= now.getTime()) {
    return { allowed: false, reason: 'session_expired' };
  }

  const restaurantId = RestaurantIdSchema.safeParse(input.restaurantId);
  if (!restaurantId.success) {
    return { allowed: false, reason: 'invalid_restaurant' };
  }

  const rawRole = await getRole(restaurantId.data, session.userId);
  const role = RoleSchema.safeParse(rawRole);
  if (!role.success) {
    // Either not a member (rawRole is null) or the database returned a
    // role this code doesn't recognise (e.g. restaurant_role gained a
    // value here hasn't been taught about yet). Both fail closed the
    // same way: denied, not a crash and not a silent allow.
    return { allowed: false, reason: 'not_a_member' };
  }
  if (minRole === 'write' && role.data === 'viewer') {
    return { allowed: false, reason: 'insufficient_role' };
  }

  return { allowed: true, role: role.data };
}
