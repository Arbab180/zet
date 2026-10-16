/**
 * Local drafts for the ledger form — NEXT_STEP's step 4, item 3's draft
 * rules. Deliberately outside src/lib/: that step says "do not touch
 * src/server/, src/lib/ or db/", and this is UI-supporting state, not a
 * shared business rule like money.ts or compute.ts.
 *
 * Framework-free on purpose, same reason src/lib/compute.ts is: the
 * decision logic (what counts as the same draft, what today's date string
 * is, how a corrupt or old-shaped localStorage value is rejected) is worth
 * unit-testing directly, without mounting a component or a browser.
 *
 * Every function that touches Storage takes it as a parameter rather than
 * reading `window.localStorage` itself, for two reasons: it is directly
 * testable with a plain object instead of a real browser, and it keeps the
 * try/catch discipline explicit at the one place these are actually called
 * from (LedgerForm.tsx), rather than hidden behind a module-level default
 * that a test could silently bypass.
 */

/** Everything a draft needs to reproduce the sheet as it was. No File
 * objects — those can't survive JSON, and nothing photo-related is meant
 * to persist yet (NEXT_STEP step 4, item 2). */
export interface LedgerDraftFields {
  businessDate: string;
  closingManagerName: string;
  signature: string;
  values: Record<string, string>;
  labels: Record<string, string>;
  slots: Record<string, string[]>;
  /**
   * Optional on purpose, like the receipt fields below. Drafts written
   * before named lines existed carry no key, and a validator demanding
   * one would throw away every sheet in progress the day this ships.
   */
  customLines?: Array<{ label: string; amount: string }>;
  // Partial on the receipt fields: drafts written before they existed are
  // still in managers' localStorage, and a stored draft is data from the
  // past, not a promise about the present.
  expenses: Array<{
    description: string;
    amount: string;
    supplier?: string;
    invoiceNumber?: string;
    invoiceDate?: string;
    /** Optional for the same reason: older drafts have no items. */
    items?: Array<{ name: string; qty: string; amount: string }>;
  }>;
  cheques: Array<{
    amount: string;
    customerName: string;
    customerPhone: string;
    chequeNumber: string;
    bank: string;
  }>;
  pendingReceipts: Array<{
    amount: string;
    organisationName: string;
    contactPerson: string;
    contactPhone: string;
    receiptNumber: string;
  }>;
  counted: string;
}

export interface StoredLedgerDraft extends LedgerDraftFields {
  savedAt: number;
}

export function draftStorageKey(restaurantId: string): string {
  return `zet:draft:${restaurantId}`;
}

/**
 * Whether two field snapshots represent the same typed-in state — the
 * dirty check. Compared against whatever the CURRENT baseline is (blank at
 * first, or a just-restored draft's own fields — see LedgerForm.tsx), never
 * against a hardcoded "empty". "If the date defaults to today, that alone
 * is not dirty" only holds if the comparison is against the real starting
 * point, not against blank.
 *
 * A plain JSON.stringify comparison is enough here: every field is plain
 * JSON-safe data (strings, and arrays/records built the same way — same
 * key order — every time this module's caller constructs a snapshot), so
 * there is no reference-identity or key-ordering trap to guard against.
 */
export function sameDraftFields(a: LedgerDraftFields, b: LedgerDraftFields): boolean {
  return JSON.stringify(normalizeFieldOrder(a)) === JSON.stringify(normalizeFieldOrder(b));
}

function normalizeFieldOrder(f: LedgerDraftFields): LedgerDraftFields {
  return {
    businessDate: f.businessDate,
    closingManagerName: f.closingManagerName,
    signature: f.signature,
    values: f.values,
    labels: f.labels,
    slots: f.slots,
    expenses: f.expenses,
    cheques: f.cheques,
    pendingReceipts: f.pendingReceipts,
    counted: f.counted,
  };
}

/**
 * Reads a draft, or null if there is none, it is corrupt, or it is shaped
 * like something from before this format existed. Every failure mode
 * returns null rather than throwing: private browsing, cleared site data
 * and a quota error all make storage.getItem or JSON.parse throw, and the
 * form must still render with a blank sheet, not a crash.
 */
export function readDraft(
  storage: Pick<Storage, 'getItem'>,
  restaurantId: string
): StoredLedgerDraft | null {
  try {
    const raw = storage.getItem(draftStorageKey(restaurantId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isStoredDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Writes the draft, or silently does nothing if storage throws (same private
 * mode / cleared site data / quota cases as readDraft). Never called with
 * File data — LedgerForm.tsx keeps any chosen receipt photo in separate,
 * non-drafted state.
 */
export function writeDraft(
  storage: Pick<Storage, 'setItem'>,
  restaurantId: string,
  fields: LedgerDraftFields,
  now: Date = new Date()
): void {
  try {
    const stored: StoredLedgerDraft = { ...fields, savedAt: now.getTime() };
    storage.setItem(draftStorageKey(restaurantId), JSON.stringify(stored));
  } catch {
    // Nothing to recover: the draft just doesn't get saved this time.
  }
}

export function clearDraft(storage: Pick<Storage, 'removeItem'>, restaurantId: string): void {
  try {
    storage.removeItem(draftStorageKey(restaurantId));
  } catch {
    // Failing to clear silently is fine — worst case, a stale draft sticks
    // around to be asked about next time, which is the safe direction to
    // fail in for a cash reconciliation.
  }
}

/**
 * Today's date as the sheet's <input type="date"> would show it —
 * YYYY-MM-DD in the LOCAL calendar day, never UTC. Cyprus is UTC+2/+3, so
 * Date#toISOString (UTC-based) can read as tomorrow or yesterday right
 * around midnight; getFullYear/getMonth/getDate are always local.
 */
export function todayLocalDateString(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isStoredDraft(value: unknown): value is StoredLedgerDraft {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.businessDate === 'string' &&
    typeof v.closingManagerName === 'string' &&
    typeof v.signature === 'string' &&
    typeof v.counted === 'string' &&
    typeof v.savedAt === 'number' &&
    isPlainObject(v.values) &&
    isPlainObject(v.labels) &&
    isPlainObject(v.slots) &&
    Array.isArray(v.expenses) &&
    Array.isArray(v.cheques) &&
    Array.isArray(v.pendingReceipts) &&
    // Absent is a VERSION, not damage — a draft written before named
    // lines existed is still a sheet someone is halfway through. Present
    // but the wrong shape IS damage, and is refused.
    (v.customLines === undefined ||
      (Array.isArray(v.customLines) &&
        v.customLines.every(
          (l) =>
            isPlainObject(l) && typeof l.label === 'string' && typeof l.amount === 'string'
        )))
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The trading day a sheet being filled in right now belongs to.
 *
 * NOT simply "today". A till closing at 01:30 belongs to the previous
 * trading day — that is the business-date rule the whole schema is built
 * on, and it is the single most likely thing for someone to get wrong at
 * that hour, because the phone says it is tomorrow.
 *
 * Before 05:00 local, the night being closed is yesterday's. After that,
 * it is today's. Five is late enough to cover any closing time and early
 * enough that nobody filling in a sheet in the morning gets yesterday.
 *
 * This is a DEFAULT, shown in the date field and freely changeable — not
 * a rule being enforced. Someone filing a sheet days later just picks the
 * date, as before.
 */
export function defaultBusinessDate(now: Date = new Date()): string {
  const d = new Date(now);
  if (d.getHours() < 5) d.setDate(d.getDate() - 1);
  return todayLocalDateString(d);
}
