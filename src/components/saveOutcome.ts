/**
 * Everything that can happen after a manager presses Αποθήκευση, reduced
 * to one rule: a save that did not happen always says so on screen.
 *
 * It did not, once. On a real night, at a restaurant, Save "did nothing no
 * matter how many times it was pressed" — three separate paths ended with
 * nothing visible:
 *
 *   1. A scanned receipt still waiting for its «Έλεγξα την απόδειξη» tick.
 *      The form refused with a 'missing_fields' result, and the banner
 *      hides 'missing_fields' because the live checklist already shows the
 *      date / manager / signature lines. The photo line is not on that
 *      checklist, so it was shown nowhere. The same was true of any server
 *      'missing_fields' line the browser's own check does not produce —
 *      a date the server will not accept, say.
 *   2. A photo upload that never finishes. The save awaited it before the
 *      button even went into its saving state, so nothing changed at all.
 *   3. The server action throwing — no connection, a timeout, a page left
 *      open across a deploy. The promise rejected and nobody caught it.
 *
 * Kept out of the components so it can be tested without React.
 */

import type { SaveReportResult } from '../server/saveReport';

/** A failure the browser detected itself; the server never answered. */
export interface ClientSaveFailure {
  ok: false;
  error: 'offline' | 'no_response' | 'photo_still_uploading';
  messages: string[];
  header?: string;
}

export type SaveOutcome = SaveReportResult | ClientSaveFailure;

export const MSG_SAVE_OFFLINE =
  'Δεν αποθηκεύτηκε — η συσκευή δεν έχει σύνδεση στο ίντερνετ. Τα στοιχεία μένουν εδώ· συνδεθείτε και πατήστε ξανά Αποθήκευση.';
export const MSG_SAVE_NO_RESPONSE =
  'Δεν αποθηκεύτηκε — δεν ήρθε απάντηση από τον διακομιστή. Τα στοιχεία μένουν εδώ· ελέγξτε τη σύνδεση και πατήστε ξανά Αποθήκευση.';
export const MSG_SAVE_PHOTO_STILL_UPLOADING =
  'Δεν αποθηκεύτηκε — μια φωτογραφία απόδειξης ακόμα ανεβαίνει. Περιμένετε λίγο ή αφαιρέστε τη και πατήστε ξανά Αποθήκευση.';

/** How long a save waits for photos already uploading before giving up. */
export const PHOTO_WAIT_MS = 45_000;

/**
 * The lines the result banner must show. 'missing_fields' lines the live
 * checklist is already showing are left out — showing them twice is noise —
 * but every other line is kept, which is the whole fix for path 1 above.
 */
export function bannerMessages(result: SaveOutcome | null, shownByChecklist: readonly string[]): string[] {
  if (result === null || result.ok) return [];
  if (result.error !== 'missing_fields') return result.messages;
  return result.messages.filter((m) => !shownByChecklist.includes(m));
}

/** Resolves true if `work` settles within `ms`, false if it does not. */
export async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls the server action and never throws. A rejection becomes a result
 * the banner can show; whether the device thinks it is online picks the
 * wording, nothing else.
 */
export async function callSave(
  action: (payload: unknown) => Promise<SaveReportResult>,
  payload: unknown,
  isOnline: () => boolean = () => typeof navigator === 'undefined' || navigator.onLine !== false
): Promise<SaveOutcome> {
  try {
    const response = await action(payload);
    // A redirect or an empty body from an old page reaching a new deploy
    // can resolve to something that is not a result at all.
    if (response && typeof response === 'object' && typeof response.ok === 'boolean') return response;
    return { ok: false, error: 'no_response', messages: [MSG_SAVE_NO_RESPONSE] };
  } catch (err) {
    console.error('save failed before the server answered', err);
    return isOnline()
      ? { ok: false, error: 'no_response', messages: [MSG_SAVE_NO_RESPONSE] }
      : { ok: false, error: 'offline', messages: [MSG_SAVE_OFFLINE] };
  }
}
