import { describe, expect, it } from 'vitest';
import { CHINA_SPICE } from '../lib/forms';
import { computeShift } from '../lib/compute';
import { parseCents } from '../lib/money';
import { columnToShiftEntry } from './shiftsEntry';
import type { ShiftColumnDraft } from './shiftsDraft';

function column(over: Partial<ShiftColumnDraft> = {}): ShiftColumnDraft {
  const methods: Record<string, string> = {};
  for (const m of CHINA_SPICE.methods) methods[m.key] = '';
  return { dineIn: '', ta: '', total: '', methods, ...over };
}

describe('the ΒΡΑΔΥ column of the real 10/09/26 sheet', () => {
  // Exactly what a manager types, commas and all — not pre-parsed numbers.
  const braduo = column({
    total: '2.592,90',
    methods: {
      CASH: '408,00',
      JCC: '1.437,58',
      GAP: '',
      FOODY: '251,80',
      B3: '',
      STRIPE: '',
      WOLT: '255,10',
      BOLT: '',
      SKASH: '',
      OTHER: '',
    },
  });

  // The night's invoices: written once on the paper and braced to a single
  // figure, not attached to any shift (migration 0005).
  const nightInvoiceCents = ['5,40', '130,00'].reduce((a, v) => a + parseCents(v), 0);

  const totals = computeShift(CHINA_SPICE, columnToShiftEntry(CHINA_SPICE, braduo));

  it('expects 648,42 in cash', () => {
    expect(totals.expectedCents).toBe(64842);
  });

  it('accounts for 408,00 in the shift itself — its cash, and nothing else', () => {
    // A shift's own TOTAL is its cash now; receipts are settled against the
    // day. The sheet's reconciled figures are asserted below, where they
    // belong.
    expect(totals.accountedCents).toBe(40800);
  });

  it('accounts for 543,40 over the night — cash plus the two invoices', () => {
    expect(totals.accountedCents + nightInvoiceCents).toBe(54340);
  });

  it('is short by 105,02, matching the circled €105 on the paper', () => {
    // The circled figure is a DAY figure. Only ΒΡΑΔΥ carried anything that
    // night, which is why this used to come out right when invoices hung
    // off the shift as well.
    expect(totals.expectedCents - (totals.accountedCents + nightInvoiceCents)).toBe(10502);
  });

  it('does not flag a split mismatch when Dine in and T/A were left blank', () => {
    expect(totals.splitMismatch).toBe(false);
  });
});

describe('columnToShiftEntry', () => {
  it('reads thousands-separated amounts through parseCents, not as decimals', () => {
    // The prototype bug: 1.234 read as one euro twenty-three.
    const entry = columnToShiftEntry(CHINA_SPICE, column({ total: '1.234' }));
    expect(entry.totalCents).toBe(123400);
  });

  it('keys methods off the config, so a stale draft cannot inject an unknown one', () => {
    const stale = column();
    (stale.methods as Record<string, string>).REVOLUT = '99,00';
    const entry = columnToShiftEntry(CHINA_SPICE, stale);
    expect(Object.keys(entry.methods).sort()).toEqual(
      CHINA_SPICE.methods.map((m) => m.key).sort()
    );
    expect(entry.methods.REVOLUT).toBeUndefined();
  });

  it('treats a method the config has but the draft lacks as zero, not NaN', () => {
    const partial = column();
    delete (partial.methods as Record<string, string>).SKASH;
    const entry = columnToShiftEntry(CHINA_SPICE, partial);
    expect(entry.methods.SKASH).toBe(0);
  });

  it('carries no invoices on a shift — they belong to the night', () => {
    // Was: joined supplier and number into a per-shift description. The
    // join now happens once, against the report.
    const entry = columnToShiftEntry(CHINA_SPICE, column({ total: '100,00' }));
    expect(entry.invoices).toEqual([]);
  });

  it('flags a split mismatch when Dine in + T/A do not make Total', () => {
    const c = column({ dineIn: '100,00', ta: '50,00', total: '200,00' });
    expect(computeShift(CHINA_SPICE, columnToShiftEntry(CHINA_SPICE, c)).splitMismatch).toBe(true);
  });
});

describe('a row the manager named by hand', () => {
  const lines = [{ label: 'ΝΙΜΑ', amounts: ['', '52,20', ''] }];

  // The paper writes ΝΙΜΑ in the blank line under SKASH — inside the
  // block of channels money ARRIVES through, not in the till. So it is
  // subtracted from ΤΑΜΕΙΟ Total like WOLT or BOLT, and the expected
  // cash drops by exactly its amount.
  it('counts as non-cash, so it lowers the cash expected', () => {
    const col = column({ total: '100,00' });
    const totals = computeShift(
      CHINA_SPICE,
      columnToShiftEntry(CHINA_SPICE, col, lines, 1)
    );
    expect(totals.nonCashCents).toBe(5220);
    expect(totals.expectedCents).toBe(4780);
  });

  it('is taken from the column it was typed in, not the first one', () => {
    const col = column({ total: '100,00' });
    const mesimeri = computeShift(
      CHINA_SPICE,
      columnToShiftEntry(CHINA_SPICE, col, lines, 0)
    );
    expect(mesimeri.nonCashCents).toBe(0);
    expect(mesimeri.expectedCents).toBe(10000);
  });

  // Someone who typed a figure and no name has not finished. The server
  // refuses that line outright, so the preview must not quietly count it
  // — a preview that disagrees with the save is worse than either.
  it('is ignored while it still has no name', () => {
    const totals = computeShift(
      CHINA_SPICE,
      columnToShiftEntry(CHINA_SPICE, column({ total: '100,00' }), [
        { label: '   ', amounts: ['', '52,20', ''] },
      ], 1)
    );
    expect(totals.nonCashCents).toBe(0);
    expect(totals.expectedCents).toBe(10000);
  });

  it('does not disturb cash', () => {
    const col = column({ total: '100,00', methods: { ...column().methods, CASH: '30,00' } });
    const totals = computeShift(
      CHINA_SPICE,
      columnToShiftEntry(CHINA_SPICE, col, lines, 1)
    );
    expect(totals.cashCents).toBe(3000);
    expect(totals.differenceCents).toBe(4780 - 3000);
  });
});
