/**
 * The reconciliation maths, with no DOM and no framework.
 *
 * This is the part that must never be trusted to the client in production:
 * the server recomputes these from the raw inputs and ignores any total the
 * browser posts.
 */

import type { Cents } from './money';
import type { LedgerForm, ShiftsForm } from './forms';

export interface LedgerEntry {
  /** Amount per input row key, e.g. { gross: 216500, card1: 164033 } */
  values: Record<string, Cents>;
  /**
   * Rows the person named by hand. Kept OUT of `values` deliberately:
   * that record is checked against the form config so a stale draft
   * cannot invent a row, and folding free-text keys into it would
   * reopen the hole that check exists to close.
   */
  customLines?: Array<{ label: string; cents: Cents }>;
  /** α)…ε) order slots per row key, when the sheet has them */
  slots?: Record<string, Cents[]>;
  expenses: Array<{ description: string; cents: Cents }>;
  countedCents: Cents;
}

export interface LedgerTotals {
  grossCents: Cents;
  subtotals: Record<string, Cents>;
  deductionCents: Cents;
  expensesCents: Cents;
  expectedCents: Cents;
  countedCents: Cents;
  varianceCents: Cents;
}

export function computeLedger(form: LedgerForm, entry: LedgerEntry): LedgerTotals {
  const v = entry.values;
  const gross = v.gross ?? 0;
  const expensesCents = entry.expenses.reduce((a, e) => a + (e.cents || 0), 0);

  let running = gross;
  const subtotals: Record<string, Cents> = {};

  for (const row of form.rows) {
    if (row.kind === 'input' && row.sign === '−') running -= v[row.key] ?? 0;
    // A group is deducted ONCE, as the sum of its parts. The parts are
    // never deducted on their own: doing both would take Foody off the
    // day's takings twice and leave every night at that branch short by
    // the whole Foody figure. The group's own key carries no value —
    // nobody types into it — so it is not read from `v` at all.
    if (row.kind === 'group' && row.sign === '−') {
      running -= row.children.reduce((a, c) => a + (v[c.key] ?? 0), 0);
    }
    if (row.kind === 'subtotal') subtotals[row.key] = running;

    // Named lines come off at the point the form nominates — which is
    // before the closing subtotal, because they are deductions like the
    // rows around them. Deducting them after it would leave the subtotal
    // claiming money the till never held.
    if (form.customLinesAfter && row.key === form.customLinesAfter) {
      running -= (entry.customLines ?? []).reduce((a, l) => a + (l.cents || 0), 0);
    }
  }

  const deductionCents = gross - running;
  const expectedCents = running - expensesCents;

  return {
    grossCents: gross,
    subtotals,
    deductionCents,
    expensesCents,
    expectedCents,
    countedCents: entry.countedCents,
    varianceCents: entry.countedCents - expectedCents,
  };
}

export interface ShiftEntry {
  dineInCents: Cents;
  taCents: Cents;
  /**
   * Set when the manager wrote words in that box instead of a figure.
   * A box holds one or the other; when a note is present its cents are 0
   * and that 0 is the ABSENCE of a figure, not a figure of zero — which
   * is the whole reason the hint below has to know.
   */
  dineInNote?: string;
  taNote?: string;
  totalCents: Cents;
  methods: Record<string, Cents>;
  /**
   * Rows the manager named by hand. Kept OUT of `methods` on purpose:
   * the loop below walks form.methods so that a stale draft or a crafted
   * payload cannot introduce a row this sheet does not have, and folding
   * free-text keys into that record would hand back exactly the hole
   * that guard exists to close. These arrive already vetted.
   */
  customLines?: Array<{ label: string; cents: Cents }>;
  invoices: Array<{ description: string; cents: Cents }>;
}

export interface ShiftTotals {
  totalCents: Cents;
  nonCashCents: Cents;
  cashCents: Cents;
  invoiceCents: Cents;
  /** Cash the sheet implies should exist */
  expectedCents: Cents;
  /** Cash counted plus invoices paid out of the till — the printed TOTAL row */
  accountedCents: Cents;
  differenceCents: Cents;
  /** true when Dine in + T/A were both entered and do not add to Total */
  splitMismatch: boolean;
}

export function computeShift(form: ShiftsForm, entry: ShiftEntry): ShiftTotals {
  let cash = 0;
  let nonCash = 0;

  for (const m of form.methods) {
    const c = entry.methods[m.key] ?? 0;
    if (m.isCash) cash += c;
    else nonCash += c;
  }

  // Non-cash, always. A named row sits in the block below CASH on the
  // printed sheet, among the channels money arrives through — so it is
  // subtracted from TOTAL to say what cash the till should hold. There is
  // deliberately no way to mark one as cash: that would change what the
  // difference line means, and it belongs in the form config where it can
  // be reviewed, not in a box someone fills at 1am.
  for (const line of entry.customLines ?? []) nonCash += line.cents || 0;

  const invoiceCents = entry.invoices.reduce((a, i) => a + (i.cents || 0), 0);
  const expectedCents = entry.totalCents - nonCash;
  const accountedCents = cash + invoiceCents;

  return {
    totalCents: entry.totalCents,
    nonCashCents: nonCash,
    cashCents: cash,
    invoiceCents,
    expectedCents,
    accountedCents,
    // Counted minus expected, the same way round as the ledger sheets and
    // the stored variance: minus means the till is short.
    differenceCents: accountedCents - expectedCents,
    // Suppressed when either box holds words. Comparing a note's 0
    // against Total would report every noted column as not adding up,
    // and a warning that is always wrong is one people learn to ignore —
    // including on the nights it is right.
    splitMismatch:
      !entry.dineInNote &&
      !entry.taNote &&
      (entry.dineInCents > 0 || entry.taCents > 0) &&
      entry.dineInCents + entry.taCents !== entry.totalCents,
  };
}

/** Order slots must add up to the row they sit beside. */
export function slotsAgree(slots: Cents[] | undefined, rowTotal: Cents): boolean {
  if (!slots || slots.every((s) => !s)) return true; // nothing itemised
  return slots.reduce((a, b) => a + (b || 0), 0) === rowTotal;
}

/** Itemised cheques or receipts must add up to their row. */
export function linesAgree(lines: Array<{ cents: Cents }>, rowTotal: Cents): boolean {
  if (!lines.length) return true;
  return lines.reduce((a, l) => a + (l.cents || 0), 0) === rowTotal;
}
