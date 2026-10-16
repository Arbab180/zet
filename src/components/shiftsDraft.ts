/**
 * Local draft storage for the CHINA SPICE shifts sheet.
 *
 * Separate from ledgerDraft.ts because the two sheets hold different shapes,
 * and a stored draft must be REJECTED when its shape does not match — a
 * ledger draft read as a shifts draft would put figures in the wrong places.
 *
 * The storage-key and today's-date helpers are imported from ledgerDraft
 * rather than copied, so the two sheets can never disagree about where a
 * draft lives or about what "today" means near midnight.
 *
 * Deliberate duplication: the try/catch read/write bodies are near-identical
 * to ledgerDraft's. They were left duplicated rather than extracted into a
 * shared generic, because ledgerDraft is covered by tests that could not be
 * run from this environment, and silently breaking a working draft path is
 * worse than forty duplicated lines. Worth collapsing into one generic core
 * the next time both files' tests can actually be executed.
 */

import { defaultBusinessDate, draftStorageKey, todayLocalDateString } from './ledgerDraft';

export { defaultBusinessDate, draftStorageKey, todayLocalDateString };

export interface ShiftInvoiceDraft {
  supplier: string;
  invoiceNumber: string;
  amount: string;
  /**
   * Optional on purpose. Drafts written before the receipt date existed
   * are still in managers' localStorage, and the validator below must keep
   * accepting them — rejecting a draft silently throws away a half-filled
   * sheet someone is in the middle of.
   */
  invoiceDate?: string;
  /** Optional for the same reason: older drafts have no items. */
  items?: Array<{ name: string; qty: string; amount: string }>;
}

export interface ShiftColumnDraft {
  dineIn: string;
  ta: string;
  total: string;
  /** method key -> what the manager typed, unparsed */
  methods: Record<string, string>;
  /**
   * Optional, and only ever read. Drafts written before invoices moved to
   * the night still carry a per-column list; the restore path folds those
   * into the night's list rather than discarding a half-filled sheet.
   */
  invoices?: ShiftInvoiceDraft[];
}

/**
 * A named extra row: one label for the night, one typed amount per shift
 * column — the shape the paper has, where the name is written once in the
 * left column and figures go across.
 */
export interface CustomLineDraft {
  label: string;
  /** Parallel to the shift columns. Short arrays are read as blank. */
  amounts: string[];
}

export interface ShiftsDraftFields {
  businessDate: string;
  closingManagerName: string;
  signature: string;
  shifts: ShiftColumnDraft[];
  /** The night's invoices — one list (migration 0005). */
  invoices: ShiftInvoiceDraft[];
  /**
   * Optional on purpose, like invoices above. Drafts written before named
   * rows existed carry no key, and a validator that demanded one would
   * throw away every sheet in progress the day this shipped.
   */
  customLines?: CustomLineDraft[];
}

export interface StoredShiftsDraft extends ShiftsDraftFields {
  savedAt: number;
}

/**
 * Value equality, not reference equality. The caller compares the live form
 * against the state it started at: a date that merely defaults to today is
 * therefore not a difference, and a mis-tap onto the wrong restaurant leaves
 * nothing behind.
 */
export function sameShiftsFields(a: ShiftsDraftFields, b: ShiftsDraftFields): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isInvoiceList(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every(
      (i) =>
        typeof i === 'object' &&
        i !== null &&
        typeof (i as ShiftInvoiceDraft).supplier === 'string' &&
        typeof (i as ShiftInvoiceDraft).invoiceNumber === 'string' &&
        typeof (i as ShiftInvoiceDraft).amount === 'string'
    )
  );
}

function isCustomLineList(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every(
      (l) =>
        typeof l === 'object' &&
        l !== null &&
        typeof (l as CustomLineDraft).label === 'string' &&
        Array.isArray((l as CustomLineDraft).amounts) &&
        (l as CustomLineDraft).amounts.every((a) => typeof a === 'string')
    )
  );
}

function isShiftColumn(v: unknown): v is ShiftColumnDraft {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.dineIn === 'string' &&
    typeof c.ta === 'string' &&
    typeof c.total === 'string' &&
    typeof c.methods === 'object' &&
    c.methods !== null &&
    !Array.isArray(c.methods) &&
    Object.values(c.methods as Record<string, unknown>).every((m) => typeof m === 'string') &&
    // ABSENT is valid: invoices moved to the night (migration 0005), so a
    // draft written since then has none here. Requiring the key rejected
    // every new draft, and a rejected draft is a silently discarded sheet.
    (c.invoices === undefined || isInvoiceList(c.invoices))
  );
}

function isStoredShiftsDraft(v: unknown): v is StoredShiftsDraft {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.businessDate === 'string' &&
    typeof d.closingManagerName === 'string' &&
    typeof d.signature === 'string' &&
    typeof d.savedAt === 'number' &&
    Array.isArray(d.shifts) &&
    d.shifts.every(isShiftColumn) &&
    // Absent in a pre-0005 draft, which is folded into the night's list on
    // restore rather than thrown away.
    (d.invoices === undefined || isInvoiceList(d.invoices)) &&
    // Same rule as invoices: absent is a version, not damage. Present but
    // the wrong type is damage, and is refused.
    (d.customLines === undefined || isCustomLineList(d.customLines))
  );
}

/**
 * Returns null for: nothing stored, unreadable storage (private mode,
 * cleared site data — getItem itself throws), invalid JSON, or JSON of the
 * wrong shape. Every one of those means "no draft", never a crash: the sheet
 * must render even when storage is unusable.
 */
export function readShiftsDraft(
  storage: Pick<Storage, 'getItem'>,
  restaurantId: string
): StoredShiftsDraft | null {
  try {
    const raw = storage.getItem(draftStorageKey(restaurantId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isStoredShiftsDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeShiftsDraft(
  storage: Pick<Storage, 'setItem'>,
  restaurantId: string,
  fields: ShiftsDraftFields,
  now: Date = new Date()
): void {
  try {
    const stored: StoredShiftsDraft = { ...fields, savedAt: now.getTime() };
    storage.setItem(draftStorageKey(restaurantId), JSON.stringify(stored));
  } catch {
    // Quota exceeded, or storage disabled. A draft is a convenience; losing
    // it must never interrupt someone closing a till.
  }
}

export function clearShiftsDraft(
  storage: Pick<Storage, 'removeItem'>,
  restaurantId: string
): void {
  try {
    storage.removeItem(draftStorageKey(restaurantId));
  } catch {
    // Worst case a stale draft lingers and is offered next time, naming its
    // own date. Never a reason to fail a save that already succeeded.
  }
}
