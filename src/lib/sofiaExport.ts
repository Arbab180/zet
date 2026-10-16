/**
 * A night's ZET as a Sofia General Ledger journal.
 *
 * Sofia's import (claude/zet-sofia-export-template.md) is double entry:
 * every row is one account, a D or a C, and an amount, and a journal's
 * debits must equal its credits. So a night is exported as
 *
 *     C  sales            — DAILY REPORT TOTAL / ΤΑΜΕΙΟ Total
 *     D  every deduction  — cards, platforms, cheques, named lines …
 *     D  every expense / invoice paid out of the till
 *     D  cash             — what was actually counted
 *     D  cash short   or  C  cash over   — the difference
 *
 * The difference line is what makes EVERY night balance, including the
 * nights the till did not. It is computed here from the lines themselves,
 * not taken from the stored variance, so the journal balances by
 * construction whatever the stored figures say.
 *
 * ── Test trial, 29/09/2026 ────────────────────────────────────────────
 *
 * No account codes yet: the accountant reads the file and keys it into
 * Sofia by hand, going by the DETAILS column. When the codes arrive they
 * go in ACCOUNT_CODES below and nothing else changes.
 *
 * Pure: no database, no Excel library. The xlsx writer lives in
 * src/server/sofiaXlsx.ts and only turns these rows into a file.
 */

import type { Cents } from './money';
import type { LedgerForm, ShiftsForm } from './forms';
import { rowLabelFor } from './forms';
import { isCustomLineKey, labelFromCustomKey } from './customLine';

export interface JournalLine {
  sign: 'D' | 'C';
  /** Always positive. The sign carries the direction. */
  cents: Cents;
  /** What the line is, in the words on the sheet. The accountant reads
   *  this to choose the account while there are no codes. */
  details: string;
  /** What kind of line, so an account code can be attached later. */
  kind: 'sales' | 'deduction' | 'expense' | 'cash' | 'short' | 'over';
  /** The stored row key, where there is one. */
  rowKey?: string;
}

const SHORT_LABEL = 'ΕΛΛΕΙΜΜΑ ΤΑΜΕΙΟΥ';
const OVER_LABEL = 'ΠΛΕΟΝΑΣΜΑ ΤΑΜΕΙΟΥ';

/** Short, over or neither, so the journal comes out even. */
function differenceLine(shortCents: Cents): JournalLine[] {
  if (shortCents > 0) return [{ sign: 'D', cents: shortCents, details: SHORT_LABEL, kind: 'short' }];
  if (shortCents < 0) return [{ sign: 'C', cents: -shortCents, details: OVER_LABEL, kind: 'over' }];
  return [];
}

function expenseDetails(e: {
  description?: string | null;
  supplierName?: string;
  invoiceNumber?: string;
}): string {
  const who = (e.supplierName || e.description || '').trim();
  const no = (e.invoiceNumber || '').trim();
  return ['ΕΞΟΔΟ', who, no].filter((p) => p !== '').join(' · ');
}

// ── Ledger sheets ──────────────────────────────────────────────────────

export interface LedgerNight {
  lines: Array<{ rowKey: string; labelOverride: string | null; amountCents: Cents }>;
  expenses: Array<{
    description: string | null;
    supplierName: string;
    invoiceNumber: string;
    amountCents: Cents;
  }>;
  countedCents: Cents;
}

/**
 * On a ledger sheet everything except DAILY REPORT TOTAL is subtracted —
 * every input row the paper prints with a «−», a group's parts, and the
 * named lines. That is checked against the config rather than assumed,
 * so a row that is not a deduction can never be exported as one.
 */
export function ledgerJournal(form: LedgerForm, night: LedgerNight): JournalLine[] {
  const deductionKeys = new Set<string>();
  // Parts posted as the row they stand in for: the card brackets go out
  // as the one SIX CARDS line the accountant has always keyed in.
  const postAs = new Map<string, string>();
  for (const row of form.rows) {
    if (row.kind === 'input' && row.sign === '−') deductionKeys.add(row.key);
    if (row.kind === 'group' && row.sign === '−') {
      for (const child of row.children) {
        deductionKeys.add(child.key);
        if (row.countsAs) postAs.set(child.key, row.countsAs);
      }
    }
  }

  const out: JournalLine[] = [];
  let grossCents = 0;
  let deducted = 0;

  for (const l of night.lines) {
    if (l.amountCents === 0) continue;
    if (l.rowKey === 'gross') {
      grossCents = l.amountCents;
      continue;
    }
    const isDeduction = deductionKeys.has(l.rowKey) || isCustomLineKey(l.rowKey);
    if (!isDeduction) continue;
    deducted += l.amountCents;
    const target = postAs.get(l.rowKey);
    // Folded into a line already out for the same row — another machine,
    // or the old card row on a night that has both — so one night never
    // posts SIX CARDS twice. Stored row keys are unique per night, so
    // only the parts of a row can ever land here.
    const already = out.find((o) => o.rowKey === (target ?? l.rowKey));
    if (already) {
      already.cents += l.amountCents;
      continue;
    }
    out.push({
      sign: 'D',
      cents: l.amountCents,
      details: target ? rowLabelFor(form, target) : rowLabelFor(form, l.rowKey, l.labelOverride),
      kind: 'deduction',
      rowKey: target ?? l.rowKey,
    });
  }

  let expensesCents = 0;
  for (const e of night.expenses) {
    if (e.amountCents === 0) continue;
    expensesCents += e.amountCents;
    out.push({ sign: 'D', cents: e.amountCents, details: expenseDetails(e), kind: 'expense' });
  }

  if (night.countedCents !== 0) {
    out.push({ sign: 'D', cents: night.countedCents, details: form.cashLabel, kind: 'cash' });
  }

  const expected = grossCents - deducted - expensesCents;
  out.push(...differenceLine(expected - night.countedCents));

  // Sales last in the list but first in meaning; placed at the top so the
  // accountant reads the night the way the paper is laid out.
  return withoutZeros([
    { sign: 'C', cents: grossCents, details: rowLabelFor(form, 'gross'), kind: 'sales', rowKey: 'gross' },
    ...out,
  ]);
}

// ── Shifts sheet (China Spice) ─────────────────────────────────────────

export interface ShiftsNight {
  shifts: Array<{ totalCents: Cents; payments: Array<{ methodKey: string; amountCents: Cents }> }>;
  invoices: Array<{ supplierName: string; invoiceNumber: string; amountCents: Cents }>;
}

/**
 * The three shift columns are summed into one journal for the day:
 * the accountant posts the day, and the paper's own day figures are the
 * sums across shifts. A method is cash only if the config says so; every
 * other method, named lines included, is a deduction — the same rule
 * computeShift uses.
 */
export function shiftsJournal(form: ShiftsForm, night: ShiftsNight): JournalLine[] {
  const cashKeys = new Set(form.methods.filter((m) => m.isCash).map((m) => m.key));

  // A card bracket is posted as the card row it is part of, so the
  // accountant keys one SIX CARDS line however many terminals took it.
  const postAs = new Map<string, string>();
  for (const m of form.methods) if (m.countsAs) postAs.set(m.key, m.countsAs);

  const totalCents = night.shifts.reduce((a, s) => a + s.totalCents, 0);
  const byKey = new Map<string, Cents>();
  for (const s of night.shifts) {
    for (const p of s.payments) {
      const key = postAs.get(p.methodKey) ?? p.methodKey;
      byKey.set(key, (byKey.get(key) ?? 0) + p.amountCents);
    }
  }

  const out: JournalLine[] = [];
  let nonCash = 0;
  let cash = 0;

  // In the order the sheet prints them, then named lines after.
  const ordered = [
    ...form.methods.map((m) => m.key).filter((k) => byKey.has(k)),
    ...[...byKey.keys()].filter((k) => isCustomLineKey(k)),
  ];
  for (const key of ordered) {
    const cents = byKey.get(key) ?? 0;
    if (cents === 0) continue;
    if (cashKeys.has(key)) {
      cash += cents;
      continue;
    }
    nonCash += cents;
    out.push({
      sign: 'D',
      cents,
      details: rowLabelFor(form, key, isCustomLineKey(key) ? labelFromCustomKey(key) : null),
      kind: 'deduction',
      rowKey: key,
    });
  }

  let invoicesCents = 0;
  for (const inv of night.invoices) {
    if (inv.amountCents === 0) continue;
    invoicesCents += inv.amountCents;
    out.push({ sign: 'D', cents: inv.amountCents, details: expenseDetails(inv), kind: 'expense' });
  }

  if (cash !== 0) out.push({ sign: 'D', cents: cash, details: 'CASH', kind: 'cash' });

  const expected = totalCents - nonCash;
  const accounted = cash + invoicesCents;
  out.push(...differenceLine(expected - accounted));

  return withoutZeros([{ sign: 'C', cents: totalCents, details: 'ΤΑΜΕΙΟ TOTAL', kind: 'sales' }, ...out]);
}

/** A €0.00 line posts nothing and is one more row to key in by hand. */
function withoutZeros(lines: JournalLine[]): JournalLine[] {
  return lines.filter((l) => l.cents !== 0);
}

// ── Checks ─────────────────────────────────────────────────────────────

export function journalBalances(lines: JournalLine[]): boolean {
  let d = 0;
  let c = 0;
  for (const l of lines) (l.sign === 'D' ? (d += l.cents) : (c += l.cents));
  return d === c;
}

// ── The Sofia row ──────────────────────────────────────────────────────

/**
 * Filled in from the sample row of the template. The company and journal
 * codes are the sample's own values and should be confirmed with the
 * accounting office; they live here so there is one place to change them.
 */
export const SOFIA_DEFAULTS = {
  companyCode: 'CBS',
  journalCode: 'JV',
  currency: 'EUR',
  currencyRate: '1.0000',
} as const;

/**
 * Account codes, by line kind or row key. EMPTY for the test trial — the
 * accountant chooses the account from the DETAILS column. Fill these in
 * once the office provides them; nothing else needs to change.
 */
export const ACCOUNT_CODES: Partial<Record<string, string>> = {};

/** Short per-restaurant tag for the REFERENCE, which Sofia caps at 15. */
const REF_TAG: Record<string, string> = {
  anamma: 'ANM',
  chop_engomi: 'ENG',
  chop_pindarou: 'PIN',
  chop_cyprus: 'MOC',
  chop_lakatamia: 'LAK',
  china_spice: 'CSP',
};

/** The template's 34 columns, A to AH, all as text. */
export type SofiaRow = string[];

export const SOFIA_COLUMN_COUNT = 34;

/** Cents to the template's number text: dot decimals, e.g. "84.80". */
export function sofiaAmount(cents: Cents): string {
  return (cents / 100).toFixed(2);
}

/** YYYY-MM-DD to the template's D/M/YYYY (the sample writes 15/4/2024). */
export function sofiaDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${Number(d)}/${Number(m)}/${y}`;
}

/** YYYY-MM-DD to MM/YYYY. */
export function sofiaPeriod(iso: string): string {
  const [y, m] = iso.split('-');
  return `${m}/${y}`;
}

export function sofiaReference(restaurantId: string, iso: string): string {
  const [y, m, d] = iso.split('-');
  const tag = REF_TAG[restaurantId] ?? restaurantId.slice(0, 3).toUpperCase();
  return `ZET-${tag}-${d}${m}${y!.slice(2)}`.slice(0, 15);
}

export function toSofiaRows(
  restaurantId: string,
  businessDate: string,
  lines: JournalLine[]
): SofiaRow[] {
  const rows = lines.map((l) => {
    const row: string[] = Array.from({ length: SOFIA_COLUMN_COUNT }, () => '');
    const amount = sofiaAmount(l.cents);
    row[0] = SOFIA_DEFAULTS.companyCode; // A
    row[1] = SOFIA_DEFAULTS.journalCode; // B
    row[2] = sofiaPeriod(businessDate); // C
    row[3] = (l.rowKey && ACCOUNT_CODES[l.rowKey]) || ACCOUNT_CODES[l.kind] || ''; // D
    row[4] = sofiaReference(restaurantId, businessDate); // E
    row[5] = sofiaDate(businessDate); // F
    row[6] = l.sign; // G
    row[7] = SOFIA_DEFAULTS.currency; // H
    row[8] = SOFIA_DEFAULTS.currencyRate; // I
    row[9] = amount; // J foreign amount — equals local for EUR
    row[10] = '0'; // K
    row[11] = amount; // L local amount
    row[12] = '0'; // M
    row[13] = l.details.slice(0, 250); // N
    return row;
  });
  // The template ends its data with a row of ten asterisks in column A —
  // almost certainly the end marker Sofia's import looks for.
  const end: string[] = Array.from({ length: SOFIA_COLUMN_COUNT }, () => '');
  end[0] = '**********';
  return [...rows, end];
}
