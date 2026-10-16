/**
 * The items on a receipt: what was bought, how much of it, what it cost.
 *
 * Read off the photo by the scan and then EDITABLE — the person holding
 * the receipt outranks the model, exactly as with the amount. Stored with
 * the receipt's own line (zet_expense_line / zet_report_invoice, migration
 * 0007) so the archive and, later, the invoicing project can use them.
 *
 * ── Items never touch the arithmetic ────────────────────────────────────
 *
 * The night reconciles against the receipt's AMOUNT, which a person has
 * confirmed. The items are a breakdown beside it. When they do not add up
 * to the amount the sheet says so and carries on (SPEC §5: show a
 * disagreement, never settle one) — a discount line, a deposit, or one
 * misread price are all ordinary, and none is a reason to block a save at
 * 1am or to quietly change a figure someone typed.
 *
 * Three shapes, one per boundary:
 *   ReceiptItemInput  strings as typed — form state, drafts, the payload
 *   ReceiptItem       cents — after the server has parsed it, and on read
 *   {name, qty, amount_cents}  the jsonb stored in the database
 *
 * The payload carries `amount` as a string, like every other amount in
 * this app: the server's one parser turns it into cents (saveReport.ts
 * rejects any posted key naming cents).
 */

import { parseCents, type Cents } from './money';

/** Far past a real till receipt; a bound so a payload cannot be unbounded. */
export const MAX_RECEIPT_ITEMS = 60;
export const MAX_ITEM_NAME = 120;
/** Free text on purpose: receipts print "2", "2 x", "1,250 kg", "6 ΤΕΜ". */
export const MAX_ITEM_QTY = 24;

export interface ReceiptItemInput {
  name: string;
  qty: string;
  amount: string;
}

export interface ReceiptItem {
  name: string;
  qty: string;
  /**
   * null when the line has no price: the scan could not read it and nobody
   * typed one. Kept apart from 0, which is a line printed as free — the
   * same distinction the sheet draws between a blank box and a zero.
   */
  amountCents: Cents | null;
}

export function blankItem(): ReceiptItemInput {
  return { name: '', qty: '', amount: '' };
}

export function isBlankItem(item: ReceiptItemInput): boolean {
  return item.name.trim() === '' && item.qty.trim() === '' && item.amount.trim() === '';
}

/**
 * Whatever a draft or an older record handed over, as a clean list.
 *
 * A draft in localStorage is data from the past: written before items
 * existed it has no key at all, and a damaged one could hold anything.
 * Neither may stop the sheet from opening.
 */
export function normaliseItems(value: unknown): ReceiptItemInput[] {
  if (!Array.isArray(value)) return [];
  const out: ReceiptItemInput[] = [];
  for (const v of value) {
    if (typeof v !== 'object' || v === null) continue;
    const r = v as Record<string, unknown>;
    out.push({
      name: typeof r.name === 'string' ? r.name : '',
      qty: typeof r.qty === 'string' ? r.qty : '',
      amount: typeof r.amount === 'string' ? r.amount : '',
    });
    if (out.length >= MAX_RECEIPT_ITEMS) break;
  }
  return out;
}

/** What the payload should carry: touched lines only, trimmed. */
export function itemsForPayload(items: ReceiptItemInput[]): ReceiptItemInput[] {
  return items
    .filter((i) => !isBlankItem(i))
    .slice(0, MAX_RECEIPT_ITEMS)
    .map((i) => ({ name: i.name.trim(), qty: i.qty.trim(), amount: i.amount.trim() }));
}

/**
 * The items added up, for the line under the list. Never throws: a
 * half-typed amount is normal while someone is typing, and it is left out
 * until it means something.
 */
export function itemsTotalCents(items: ReceiptItemInput[]): Cents {
  let total = 0;
  for (const i of items) {
    if (i.amount.trim() === '') continue;
    try {
      const cents = parseCents(i.amount);
      if (Number.isSafeInteger(cents)) total += cents;
    } catch {
      // Still being typed.
    }
  }
  return total;
}

/**
 * How the items compare with the receipt's amount.
 *
 * `null` when there is nothing to compare: no items priced, or no amount
 * on the line yet. A difference is information for the person, not a
 * verdict — see the note at the top of this file.
 */
export function itemsDifference(
  items: ReceiptItemInput[],
  lineAmount: string
): { itemsCents: Cents; lineCents: Cents; differenceCents: Cents } | null {
  const priced = items.some((i) => i.amount.trim() !== '');
  if (!priced || lineAmount.trim() === '') return null;
  let lineCents: Cents;
  try {
    lineCents = parseCents(lineAmount);
  } catch {
    return null;
  }
  const itemsCents = itemsTotalCents(items);
  return { itemsCents, lineCents, differenceCents: lineCents - itemsCents };
}

// ── The database's shape ───────────────────────────────────────────────

/** The jsonb text to store, or '' for "no items" (stored as NULL). */
export function itemsToDbJson(items: ReceiptItem[]): string {
  if (items.length === 0) return '';
  return JSON.stringify(
    items.map((i) => ({ name: i.name, qty: i.qty, amount_cents: i.amountCents }))
  );
}

/**
 * Reads the stored jsonb back. Defensive for the same reason as
 * normaliseItems: this column is read on every archive page, and one odd
 * row must not take the page down with it.
 */
export function itemsFromDb(value: unknown): ReceiptItem[] {
  let list: unknown = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: ReceiptItem[] = [];
  for (const v of list) {
    if (typeof v !== 'object' || v === null) continue;
    const r = v as Record<string, unknown>;
    const cents = r.amount_cents == null ? null : Number(r.amount_cents);
    out.push({
      name: typeof r.name === 'string' ? r.name : '',
      qty: typeof r.qty === 'string' ? r.qty : '',
      amountCents: cents != null && Number.isSafeInteger(cents) && cents >= 0 ? cents : null,
    });
  }
  return out;
}

/**
 * Stored items back into the strings the form edits. The formatter is
 * passed in, as everywhere on the read-back path, so there is one way an
 * amount is written for the form.
 */
export function itemsForEdit(
  items: ReceiptItem[],
  formatAmount: (cents: Cents) => string
): ReceiptItemInput[] {
  return items.map((i) => ({
    name: i.name,
    qty: i.qty,
    amount: i.amountCents == null ? '' : formatAmount(i.amountCents),
  }));
}

/** The priced items added up, for the archive. */
export function storedItemsTotalCents(items: ReceiptItem[]): Cents {
  return items.reduce((a, i) => a + (i.amountCents ?? 0), 0);
}
