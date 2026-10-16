/**
 * Approving a night.
 *
 * The rule, decided 05/10/2026 when each restaurant got its own login, and
 * replacing the two-tier rule of 23/09/2026 (unflagged nights by anyone,
 * flagged by an admin):
 *
 *   - ONLY an admin approves, flagged or not. A restaurant files its night
 *     and may keep fixing it until then; approving is the admin's check
 *     that it is right, and after it the night is the admin's to correct.
 *
 * Flags still matter: they are what the admin looks at first, and the
 * dashboard lists them.
 *
 * Enforced HERE, server-side, re-checked on every request — not by hiding
 * a button. A hidden button stops honest people; it does not stop anyone
 * who opens devtools, which is the entire population this rule exists for.
 *
 * Note what this deliberately is NOT: a correction. Approving moves a
 * 'submitted' report to 'approved', which the database treats as an
 * ordinary status change. Editing an ALREADY-approved report is a
 * different operation that must bump revision_no and archive a snapshot
 * (migration 0003), and it does not live here.
 */

import { withUserTransaction, getRestaurantRole } from '../lib/db';
import { authorizeRestaurantAccess, type Session } from '../lib/authorize';
import { getReportDetail } from './reports';
import { MSG_ADMIN_REQUIRED, MSG_NOT_ALLOWED } from '../lib/messages';

export type ApproveResult =
  | { ok: true; status: 'approved' }
  | {
      ok: false;
      error: 'not_authorised' | 'not_found' | 'admin_required' | 'wrong_status';
      message: string;
    };

const MSG_NOT_FOUND = 'Δεν βρέθηκε το κλείσιμο.';
const MSG_WRONG_STATUS = 'Αυτό το κλείσιμο δεν είναι σε κατάσταση που εγκρίνεται.';

export async function approveReport(
  session: Session | null,
  restaurantId: string,
  businessDate: string,
  now: Date = new Date()
): Promise<ApproveResult> {
  if (!session) {
    return { ok: false, error: 'not_authorised', message: MSG_NOT_ALLOWED };
  }

  const detail = await getReportDetail(session.userId, restaurantId, businessDate);
  if (!detail) {
    return { ok: false, error: 'not_found', message: MSG_NOT_FOUND };
  }
  if (detail.status !== 'submitted') {
    return { ok: false, error: 'wrong_status', message: MSG_WRONG_STATUS };
  }

  return withUserTransaction(session.userId, async (client) => {
    const decision = await authorizeRestaurantAccess({
      session,
      restaurantId,
      minRole: 'write',
      now,
      // The client-taking overload: this must run in the SAME transaction
      // as the update it authorises, not a second connection.
      getRole: (rid, uid) => getRestaurantRole(client, uid, rid),
    });

    if (!decision.allowed) {
      return { ok: false as const, error: 'not_authorised' as const, message: MSG_NOT_ALLOWED };
    }

    if (decision.role !== 'admin') {
      return { ok: false as const, error: 'admin_required' as const, message: MSG_ADMIN_REQUIRED };
    }

    const { rowCount } = await client.query(
      `UPDATE zet_report
          SET status = 'approved', approved_at = $3, approved_by = $4
        WHERE restaurant_id = $1 AND business_date = $2::date
          AND status = 'submitted'`,
      [restaurantId, businessDate, now, session.userId]
    );

    // Zero rows means something changed underneath us between the read and
    // the write — someone else approved it, or RLS hid it. Not an error to
    // paper over.
    if (rowCount === 0) {
      return { ok: false as const, error: 'wrong_status' as const, message: MSG_WRONG_STATUS };
    }

    return { ok: true as const, status: 'approved' as const };
  });
}

/**
 * What the UI needs to decide whether to offer an Approve button. The
 * button is a convenience; approveReport re-checks all of this regardless.
 */
export async function canApprove(
  session: Session | null,
  restaurantId: string
): Promise<boolean> {
  return (await roleFor(session, restaurantId)) === 'admin';
}

/**
 * The caller's role for this restaurant, read fresh (CLAUDE.md rule 3), or
 * null. For the pages' "may this person correct / export" questions.
 */
export async function roleFor(
  session: Session | null,
  restaurantId: string
): Promise<string | null> {
  if (!session) return null;
  return getRestaurantRole(session.userId, restaurantId);
}
