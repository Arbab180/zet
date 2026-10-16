/**
 * What makes a saved night need someone's attention.
 *
 * Decided with the owner on 23/09/2026 — see claude/zet-flagging-policy.md
 * in the Claude project, which supersedes docs/SPEC.md §5 on this one point.
 *
 * Saving still never blocks and the form still does not argue with the
 * figures. A flag is raised AFTER the fact, on a report that saved fine.
 *
 * Only discrepancies visible on the night are flagged here. The ones that
 * cost the most — an order the customer cancelled that the restaurant
 * recorded as successful, or one left pending that never went through —
 * are invisible until the platform pays out days later, and catching those
 * needs payout reconciliation, deliberately deferred.
 *
 * Pure, and takes plain numbers: no database, no React, so the rule itself
 * can be tested directly.
 */

/**
 * A few cents does not matter; fifty does. The owner's words: "if its a few
 * cents dw about it but if its like 1 euro or even 50 cents and more then
 * it should be a major concern".
 *
 * One constant, not a literal scattered about, so it can be changed without
 * a hunt. Not per-restaurant configurable until somebody asks.
 */
export const FLAG_THRESHOLD_CENTS = 50;

export type FlagKind = 'cash_variance' | 'slots_disagree';

export interface Flag {
  kind: FlagKind;
  /** Always positive: how far out, in cents. */
  amountCents: number;
  /** Which row, for slots_disagree. */
  rowKey?: string;
  /**
   * What to CALL that row. Separate from the key because the archive
   * list cannot know it: its query works out only the widest difference
   * across the night, not which row produced it.
   */
  rowLabel?: string;
}

export interface FlagInput {
  /** actual − expected, as stored. Negative means the till was short. */
  varianceCents: number;
  /**
   * One entry per itemised row whose α)…ε) slots were filled in at all.
   * Rows with no slots are not compared — the paper lets someone write only
   * the total, and that is not an error.
   */
  slotRows?: Array<{ rowKey: string; rowLabel?: string; rowCents: number; slotTotalCents: number }>;
}

export function flagsFor(input: FlagInput): Flag[] {
  const flags: Flag[] = [];

  const variance = Math.abs(input.varianceCents);
  if (variance >= FLAG_THRESHOLD_CENTS) {
    flags.push({ kind: 'cash_variance', amountCents: variance });
  }

  for (const row of input.slotRows ?? []) {
    const diff = Math.abs(row.rowCents - row.slotTotalCents);
    if (diff >= FLAG_THRESHOLD_CENTS) {
      flags.push({
        kind: 'slots_disagree',
        amountCents: diff,
        rowKey: row.rowKey,
        rowLabel: row.rowLabel,
      });
    }
  }

  return flags;
}

export function isFlagged(input: FlagInput): boolean {
  return flagsFor(input).length > 0;
}

/**
 * Greek, plain, and about the money rather than about a rule being broken —
 * the same tone as the messages in src/lib/messages.ts.
 *
 * `formatCents` is passed in rather than imported so this file stays free of
 * everything but arithmetic.
 */
export function describeFlag(flag: Flag, formatCents: (c: number) => string): string {
  switch (flag.kind) {
    case 'cash_variance':
      return `Τα μετρητά δεν συμφωνούν: διαφορά ${formatCents(flag.amountCents)}`;
    case 'slots_disagree': {
      // No prefix at all when the row is not known. The archive list
      // reports only the widest difference on the night and has no row
      // to name, and prefixing that with an empty string printed a bare
      // ": " in front of the sentence as though a word had gone missing.
      const named = (flag.rowLabel ?? flag.rowKey ?? '').trim();
      const where = named === '' ? '' : `${named}: `;
      return `${where}οι παραγγελίες δεν βγάζουν το σύνολο — διαφορά ${formatCents(
        flag.amountCents
      )}`;
    }
  }
}
