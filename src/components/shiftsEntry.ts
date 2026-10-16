/**
 * Turns one shift column of typed strings into the cents-shaped ShiftEntry
 * that src/lib/compute.ts understands.
 *
 * Extracted out of ShiftsForm.tsx so it can be tested without rendering
 * React. This mapping is where a wiring mistake would hide — a method key
 * read from the wrong place, or an amount that never reaches parseCents —
 * and such a mistake would be invisible on screen because the totals would
 * still look like plausible numbers.
 *
 * This is PREVIEW arithmetic only. Nothing it returns is ever posted:
 * src/server/saveReport.ts recomputes independently from the same raw
 * strings, and the server's answer is the one that gets stored.
 */

import type { ShiftsForm } from '../lib/forms';
import type { ShiftEntry } from '../lib/compute';
import { parseCents, splitFigureOrNote } from '../lib/money';
import type { CustomLineDraft, ShiftColumnDraft } from './shiftsDraft';
import { normaliseCustomLabel } from '../lib/customLine';

export function columnToShiftEntry(
  form: ShiftsForm,
  column: ShiftColumnDraft,
  /** The night's named rows; this column's figure is taken by index. */
  customLines: CustomLineDraft[] = [],
  shiftIndex = 0
): ShiftEntry {
  const methods: Record<string, number> = {};
  // Keyed off the CONFIG, not off whatever keys the column happens to hold,
  // so a stale draft cannot introduce a method this sheet does not have.
  for (const m of form.methods) methods[m.key] = parseCents(column.methods[m.key] ?? '');

  // An unnamed row is not a row. Someone who types a figure and no label
  // has not finished; counting it here would make the preview disagree
  // with the server, which refuses the same line for the same reason.
  const named = form.allowCustomLines
    ? customLines
        .filter((l) => normaliseCustomLabel(l.label) !== '')
        .map((l) => ({
          label: normaliseCustomLabel(l.label),
          cents: parseCents(l.amounts[shiftIndex] ?? ''),
        }))
    : [];

  // Dine in and T/A may hold words. Total may not: it is the figure the
  // night reconciles against.
  const dineIn = splitFigureOrNote(column.dineIn);
  const ta = splitFigureOrNote(column.ta);

  return {
    dineInCents: dineIn.cents,
    dineInNote: dineIn.note,
    taCents: ta.cents,
    taNote: ta.note,
    totalCents: parseCents(column.total),
    methods,
    customLines: named,
    // Empty on purpose. Invoices are settled against the DAY, not a
    // shift — the paper writes one list for the night and braces it to a
    // single figure — so a shift's own TOTAL is its cash alone. The day's
    // invoice total is added once, by the caller, to the report.
    invoices: [],
  };
}
