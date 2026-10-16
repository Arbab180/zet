'use server';

/**
 * The Next.js wiring for src/server/saveReport.ts, per that module's own
 * doc comment: three real lines — read the session, call the action,
 * return its result untouched. Nothing else belongs here; the decision
 * logic lives in saveReport.ts precisely so it stays unit-testable without
 * a running framework.
 *
 * Who is this? getCurrentSession() reads the signed session cookie set by
 * src/app/login/actions.ts and verifies it against SESSION_SECRET. An
 * unsigned, tampered, expired or absent cookie yields null, and
 * saveDailyReport then correctly refuses the save with
 * `{ error: 'not_authorised', reason: 'no_session' }`.
 *
 * The save is attributed to whoever is signed in — the admin or a
 * restaurant's own login (src/server/auth.ts) — and authorised against
 * that user's restaurant membership. Nothing below has to know which.
 */

import { saveDailyReport, type SaveReportResult } from '../server/saveReport';
import { getCurrentSession } from '../server/currentSession';

/**
 * One wrapper, both layouts. saveDailyReport branches on the restaurant's
 * own layout (src/lib/forms.ts) to decide whether `payload` should carry a
 * `ledger` or a `shifts` block — this function doesn't need to know which,
 * and didn't need renaming when the shifts form (docs/PROMPTS.md step 5)
 * started calling it too.
 */
export async function saveReportAction(payload: unknown): Promise<SaveReportResult> {
  const session = await getCurrentSession();
  return saveDailyReport(payload, { session });
}
