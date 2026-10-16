import { SOFIA_COLUMN_COUNT, type SofiaRow } from '../lib/sofiaExport';
import { textXlsx } from './textXlsx';

/**
 * Sofia rows as a workbook shaped like the accounting office's template
 * (SOFIA_GL_ENTRIES_IMPORT.xlsx): one sheet, "Sheet1", data from the FIRST
 * row — the template's header row is documentation for us, not part of an
 * import file — and every cell text («@»), so Excel never turns "09/2026"
 * into a date or "1.0000" into 1.
 *
 * Column widths are for the person reading it; Sofia ignores them.
 */
const WIDTHS: Record<number, number> = {
  0: 8, 1: 6, 2: 9, 3: 10, 4: 16, 5: 11, 6: 5, 7: 5, 8: 8, 9: 11, 10: 5, 11: 11, 12: 5, 13: 36,
};

export function sofiaWorkbook(rows: SofiaRow[]): Buffer {
  return textXlsx({ name: 'Sheet1', rows, widths: WIDTHS, columnCount: SOFIA_COLUMN_COUNT });
}
