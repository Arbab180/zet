/**
 * Card brackets: the card row split into numbered boxes, one per card
 * machine, added and removed by the manager on the night's sheet.
 *
 * Asked for 09/10/2026: a restaurant's card takings come off more than one
 * terminal, and the manager wants each batch on its own line — 1, 2, 3 …
 * under SIX CARDS, as many as were used that night. No names, no setup.
 *
 * Pure, and shared by the browser and the server ON PURPOSE: the server
 * rebuilds the sheet from the same function and the same count, so every
 * box the browser showed is a row the save accepts and recomputes.
 *
 * ── What the sheet looks like ──────────────────────────────────────────
 *
 *   0 brackets   exactly as before: one SIX CARDS box to type in.
 *   1 or more    SIX CARDS becomes a read-only total with the numbered
 *                boxes under it. The total is their sum and it is what is
 *                deducted — once (computeLedger reads a group's parts,
 *                never the group; computeShift counts each method once).
 *
 * ── Keys ───────────────────────────────────────────────────────────────
 *
 * Bracket n is stored under CARD_n. How many a night has is not stored
 * anywhere separately: it is the highest CARD_n the night holds, so a
 * night always reopens with the brackets it was filed with. While there
 * are brackets the old card row (card2 / GAP) is RETIRED rather than
 * removed — hidden unless it carries a figure — so a night filed before
 * brackets existed keeps the line it was balanced with.
 */

import type { LedgerForm, LedgerRow, ShiftsForm, ZetForm } from './forms';

export const CARD_BRACKET_PREFIX = 'CARD_';

/** A ceiling on what a payload can add, not a target. */
export const MAX_CARD_BRACKETS = 12;

/** The total row on a ledger sheet. Never stored: the brackets are. */
export const CARD_BRACKETS_GROUP_KEY = 'CARD_BRACKETS';

export function cardBracketKey(n: number): string {
  return CARD_BRACKET_PREFIX + n;
}

/** n for CARD_n within the ceiling, otherwise null. */
export function cardBracketNumber(key: string): number | null {
  const m = /^CARD_([1-9]\d?)$/.exec(key);
  if (!m) return null;
  const n = Number(m[1]);
  return n <= MAX_CARD_BRACKETS ? n : null;
}

/**
 * How many brackets a set of row keys implies: the highest CARD_n among
 * them. A key past the ceiling is ignored here, which leaves it unknown to
 * the sheet — and the save refuses unknown rows.
 */
export function cardBracketCount(keys: Iterable<string>): number {
  let max = 0;
  for (const k of keys) {
    const n = cardBracketNumber(k);
    if (n !== null && n > max) max = n;
  }
  return max;
}

export function withCardBrackets(form: LedgerForm, count: number): LedgerForm;
export function withCardBrackets(form: ShiftsForm, count: number): ShiftsForm;
export function withCardBrackets(form: ZetForm, count: number): ZetForm;
export function withCardBrackets(form: ZetForm, count: number): ZetForm {
  const n = Math.min(Math.max(0, Math.floor(count)), MAX_CARD_BRACKETS);
  if (!form.cardRowKey || n === 0) return form;
  const numbers = Array.from({ length: n }, (_, i) => i + 1);

  if (form.layout === 'ledger') {
    const at = form.rows.findIndex((r) => r.kind === 'input' && r.key === form.cardRowKey);
    if (at === -1) return form;
    const cardRow = form.rows[at] as Extract<LedgerRow, { kind: 'input' }>;
    const group: LedgerRow = {
      kind: 'group',
      key: CARD_BRACKETS_GROUP_KEY,
      label: cardRow.label,
      sign: cardRow.sign,
      countsAs: cardRow.key,
      children: numbers.map((i) => ({ key: cardBracketKey(i), label: String(i) })),
    };
    return {
      ...form,
      rows: [
        ...form.rows.slice(0, at),
        { ...cardRow, retired: true as const },
        group,
        ...form.rows.slice(at + 1),
      ],
    };
  }

  const at = form.methods.findIndex((m) => m.key === form.cardRowKey);
  if (at === -1) return form;
  const cardMethod = form.methods[at]!;
  return {
    ...form,
    methods: [
      ...form.methods.slice(0, at),
      { ...cardMethod, retired: true as const },
      ...numbers.map((i) => ({ key: cardBracketKey(i), label: String(i), countsAs: cardMethod.key })),
      ...form.methods.slice(at + 1),
    ],
  };
}

/**
 * Every bracket a stored night could hold. For the surfaces that only READ
 * a night — the archive and the Sofia export — so a stored CARD_n is named
 * and folded into the card line whatever count it was filed with.
 */
export function withAllCardBrackets(form: ZetForm): ZetForm {
  return withCardBrackets(form, MAX_CARD_BRACKETS);
}

/**
 * Removing bracket `index` (1-based) from a set of values: the ones after
 * it move up one, so the numbers stay 1…n with no gap. Returns new values;
 * the last bracket's key is dropped.
 */
export function removeCardBracket<T>(
  values: Record<string, T>,
  count: number,
  index: number
): Record<string, T> {
  const out = { ...values };
  for (let i = index; i < count; i++) {
    const next = out[cardBracketKey(i + 1)];
    if (next === undefined) delete out[cardBracketKey(i)];
    else out[cardBracketKey(i)] = next;
  }
  delete out[cardBracketKey(count)];
  return out;
}

/**
 * How many brackets a sheet opens with: the highest one holding a figure.
 * A read-back hands every possible bracket back, blank or not, so counting
 * keys would open every night with all twelve.
 */
export function filledCardBrackets(values: Record<string, string>): number {
  return cardBracketCount(Object.keys(values).filter((k) => (values[k] ?? '').trim() !== ''));
}

/** Values without brackets past `count` — what a sheet showing `count` posts. */
export function withoutHiddenBrackets<T>(values: Record<string, T>, count: number): Record<string, T> {
  return Object.fromEntries(
    Object.entries(values).filter(([k]) => {
      const n = cardBracketNumber(k);
      return n === null || n <= count;
    })
  );
}
