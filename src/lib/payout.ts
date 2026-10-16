/**
 * Reconciling a platform's payout statement against the nights it covers.
 *
 * ── What the sheet's FOODY / WOLT / BOLT figure means ──────────────────
 *
 * Derived from the sheet's own arithmetic, not assumed. Expected cash is
 *
 *     Total − [cards, FOODY, WOLT, BOLT, …]
 *
 * so for that to come out right, every subtracted row means one thing:
 * money rung up on the POS that did NOT end up as cash in the till.
 *
 * That settles a question the statement raises. Foody's per-order appendix
 * lists cash orders twice over: some with Συνολική Αξία 23,90, some with
 * 0,00. The 0,00 ones are cash the restaurant's own side collected — it
 * went into the till, so subtracting it would leave the sheet reporting
 * the till as over. The others are cash Foody collected and owes back, so
 * they must be subtracted like any card order.
 *
 * So the row equals what the platform COLLECTED on the restaurant's
 * behalf — Συνολική Αξία per order, and the statement's «Σύνολο
 * Εισπράξεων / Total amount received» in total. Not the commissionable
 * value, and not the net payment.
 *
 * ── Why commission must stay out of it ─────────────────────────────────
 *
 * The platform pays the gross less its fees. Comparing the sheet against
 * the BANK figure would report a discrepancy of several hundred euro every
 * single week — correctly, forever — and the real loss would be invisible
 * inside it. Gross against gross; fees are a known, agreed deduction and
 * are checked separately.
 *
 * ── What this is actually looking for ──────────────────────────────────
 *
 * An order the customer cancelled, or one left pending that never went
 * through, which the restaurant recorded as a real sale. The sheet is then
 * internally consistent, its arithmetic perfect, and the money never
 * arrives. Nothing computable on the night can see it. See
 * claude/zet-flagging-policy.md §2.
 */

import type { Cents } from './money';

export interface PayoutOrder {
  /** The day the order was placed — NOT the invoice date. */
  orderDate: string;
  reference: string;
  /** Συνολική Αξία: what the platform collected for this order. */
  receivedCents: Cents;
}

export interface PayoutStatement {
  platform: string;
  /** The platform's own venue id, e.g. CY_FD_2719_2719. Stable, and the
   *  reliable way to match a statement to a restaurant — a name is not. */
  venueCode: string;
  /** Idempotency: the same statement imported twice must not double up. */
  invoiceNumber: string;
  periodFrom: string;
  periodTo: string;
  /** «Σύνολο Εισπράξεων» — the figure the sheets are compared against. */
  grossReceivedCents: Cents;
  /** The platform's invoice for the period, fees and VAT. Not part of the
   *  comparison; carried so it can be filed as the expense it is. */
  feesCents: Cents;
  /** «Ποσό πληρωτέο» — what should reach the bank. */
  payableCents: Cents;
  /** Present when the appendix was read, absent when only the summary was. */
  orders?: PayoutOrder[];
}

/** One night, as the sheets hold it. `recordedCents` is null when no sheet
 *  was filed for that date — which is not the same as a night of zero. */
export interface NightRecord {
  businessDate: string;
  recordedCents: Cents | null;
}

export interface DayComparison {
  businessDate: string;
  recordedCents: Cents | null;
  statementCents: Cents;
  /** recorded − statement. Positive means the sheet claimed more than the
   *  platform collected, which is the cancelled-order case. */
  differenceCents: Cents | null;
}

export interface PayoutComparison {
  periodFrom: string;
  periodTo: string;
  nightsInPeriod: number;
  nightsWithSheet: number;
  /** Dates in the period with no sheet at all. */
  missingDates: string[];
  recordedCents: Cents;
  statementCents: Cents;
  differenceCents: Cents;
  /**
   * False when a night in the period has no sheet, or when the statement
   * does not add up internally.
   *
   * A period missing three of its seven nights is short by three nights of
   * real orders, and reporting that as a loss would be a lie with a number
   * on it. The difference is still returned — for context, never as a
   * verdict — and whoever reads it is told what is missing.
   */
  comparable: boolean;
  /** Per night, when the statement carried its per-order appendix. */
  days?: DayComparison[];
}

/** Every date from..to inclusive, as YYYY-MM-DD. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return out;
  for (let d = start; d <= end; d = new Date(d.getTime() + 86_400_000)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Does the statement agree with itself? gross − fees should be what it
 * says is payable.
 *
 * Worth checking because these figures are read off a scan, and a
 * misread digit would otherwise become a discrepancy blamed on the
 * restaurant. A statement that does not balance is a bad READ, not a bad
 * night.
 */
export function statementBalances(s: PayoutStatement): boolean {
  return s.grossReceivedCents - s.feesCents === s.payableCents;
}

export function comparePayout(
  statement: PayoutStatement,
  nights: NightRecord[]
): PayoutComparison {
  const dates = datesBetween(statement.periodFrom, statement.periodTo);
  const byDate = new Map(nights.map((n) => [n.businessDate, n]));

  const inPeriod = dates.map((d) => byDate.get(d) ?? { businessDate: d, recordedCents: null });
  const withSheet = inPeriod.filter((n) => n.recordedCents !== null);
  const missingDates = inPeriod.filter((n) => n.recordedCents === null).map((n) => n.businessDate);

  const recordedCents = withSheet.reduce((a, n) => a + (n.recordedCents ?? 0), 0);

  // Per night only when the appendix was read. Summing the orders gives a
  // per-day statement figure; without it there is one weekly total and no
  // way to say which night drifted.
  let days: DayComparison[] | undefined;
  if (statement.orders) {
    const perDay = new Map<string, Cents>();
    for (const o of statement.orders) {
      perDay.set(o.orderDate, (perDay.get(o.orderDate) ?? 0) + o.receivedCents);
    }
    days = inPeriod.map((n) => {
      const statementCents = perDay.get(n.businessDate) ?? 0;
      return {
        businessDate: n.businessDate,
        recordedCents: n.recordedCents,
        statementCents,
        differenceCents: n.recordedCents === null ? null : n.recordedCents - statementCents,
      };
    });
  }

  return {
    periodFrom: statement.periodFrom,
    periodTo: statement.periodTo,
    nightsInPeriod: dates.length,
    nightsWithSheet: withSheet.length,
    missingDates,
    recordedCents,
    statementCents: statement.grossReceivedCents,
    differenceCents: recordedCents - statement.grossReceivedCents,
    comparable: missingDates.length === 0 && statementBalances(statement),
    days,
  };
}
