/**
 * Named extra rows on a shifts sheet — the blank line under SKASH that
 * the China Spice managers write "ΝΙΜΑ" on.
 *
 * The label is the identity. There is no separate label column in the
 * database: the name the manager typed IS the method_key, behind a
 * reserved prefix that cannot collide with a configured method. That
 * keeps the whole feature inside the existing zet_shift_payment shape —
 * free-text method_key, UNIQUE (shift_id, method_key) — so no migration
 * is needed and zet_report_snapshot()'s to_jsonb(sp.*) picks these rows
 * up for the audit trail without being told about them.
 *
 * Shared by the browser and the server ON PURPOSE. If the two ever
 * derived keys differently, a line would save under one key and restore
 * under another, and the amount would quietly vanish from the sheet.
 */

/** Reserved. No configured method key may start with this. */
export const CUSTOM_LINE_PREFIX = 'X:';

/**
 * A ceiling, not a target. The paper has one spare line; this allows a
 * few for the cases the paper handles by writing in the margin, while
 * still bounding what a crafted payload can insert per shift.
 */
export const MAX_CUSTOM_LINES = 6;

/** Long enough for a supplier or platform name, short enough to fit the
 * label column without wrapping the whole grid. */
export const MAX_CUSTOM_LABEL = 24;

/** Collapse the whitespace a phone keyboard leaves behind. Case is kept:
 * the accountant reads this name, so "Nima" must not become "NIMA". */
export function normaliseCustomLabel(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_CUSTOM_LABEL);
}

export function customLineKey(label: string): string {
  return CUSTOM_LINE_PREFIX + normaliseCustomLabel(label);
}

export function isCustomLineKey(key: string): boolean {
  return key.startsWith(CUSTOM_LINE_PREFIX);
}

export function labelFromCustomKey(key: string): string {
  return isCustomLineKey(key) ? key.slice(CUSTOM_LINE_PREFIX.length) : key;
}

/**
 * Case-insensitive, because two rows called "Nima" and "NIMA" are one
 * row as far as the person filling the sheet is concerned, and letting
 * both through would split one platform's takings across two lines.
 */
export function duplicateLabel(labels: string[]): string | null {
  const seen = new Set<string>();
  for (const raw of labels) {
    const label = normaliseCustomLabel(raw);
    if (label === '') continue;
    const fold = label.toUpperCase();
    if (seen.has(fold)) return label;
    seen.add(fold);
  }
  return null;
}
