import { describe, expect, it } from 'vitest';
import { FORMS, type LedgerForm, type ShiftsForm } from './forms';
import { computeLedger } from './compute';
import { customLineKey } from './customLine';
import {
  journalBalances,
  ledgerJournal,
  shiftsJournal,
  sofiaAmount,
  sofiaDate,
  sofiaPeriod,
  sofiaReference,
  toSofiaRows,
  SOFIA_COLUMN_COUNT,
  type JournalLine,
} from './sofiaExport';

const anamma = FORMS.anamma as LedgerForm;
const pindarou = FORMS.chop_pindarou as LedgerForm;
const chinaSpice = FORMS.china_spice as ShiftsForm;

const line = (rowKey: string, amountCents: number, labelOverride: string | null = null) => ({
  rowKey,
  labelOverride,
  amountCents,
});

function sum(lines: JournalLine[], sign: 'D' | 'C') {
  return lines.filter((l) => l.sign === sign).reduce((a, l) => a + l.cents, 0);
}

describe('ledgerJournal', () => {
  it('turns a night that adds up into sales against deductions, expenses and cash', () => {
    const j = ledgerJournal(anamma, {
      lines: [line('gross', 100000), line('card2', 40000), line('WOLT', 10000)],
      expenses: [{ description: null, supplierName: 'ΛΑΙΚΗ', invoiceNumber: 'A12', amountCents: 5000 }],
      countedCents: 45000,
    });
    expect(journalBalances(j)).toBe(true);
    expect(j[0]).toMatchObject({ sign: 'C', cents: 100000, details: 'DAILY REPORT TOTAL' });
    expect(j.map((l) => l.details)).toEqual([
      'DAILY REPORT TOTAL',
      'SIX CARDS',
      'WOLT ΟΛΙΚΟ',
      'ΕΞΟΔΟ · ΛΑΙΚΗ · A12',
      anamma.cashLabel,
    ]);
    expect(j.some((l) => l.kind === 'short' || l.kind === 'over')).toBe(false);
  });

  it('balances a short night with a debit the size of the shortfall', () => {
    const j = ledgerJournal(anamma, {
      lines: [line('gross', 100000), line('card2', 40000)],
      expenses: [],
      countedCents: 59000,
    });
    expect(journalBalances(j)).toBe(true);
    expect(j.at(-1)).toMatchObject({ sign: 'D', kind: 'short', cents: 1000 });
  });

  it('balances an over night with a credit the size of the excess', () => {
    const j = ledgerJournal(anamma, {
      lines: [line('gross', 100000), line('card2', 40000)],
      expenses: [],
      countedCents: 60250,
    });
    expect(journalBalances(j)).toBe(true);
    expect(j.at(-1)).toMatchObject({ sign: 'C', kind: 'over', cents: 250 });
  });

  it('agrees with the sheet on how short the night is', () => {
    const values = { gross: 123456, card2: 30000, FOODY: 12345, BOLT: 999 };
    const counted = 70000;
    const totals = computeLedger(anamma, { values, expenses: [{ description: 'x', cents: 1500 }], countedCents: counted });
    const j = ledgerJournal(anamma, {
      lines: Object.entries(values).map(([k, v]) => line(k, v)),
      expenses: [{ description: 'x', supplierName: '', invoiceNumber: '', amountCents: 1500 }],
      countedCents: counted,
    });
    const diff = j.find((l) => l.kind === 'short' || l.kind === 'over');
    const signed = diff ? (diff.kind === 'short' ? diff.cents : -diff.cents) : 0;
    expect(signed).toBe(-totals.varianceCents);
  });

  it("exports Pindarou's Foody as its two parts, never the total as well", () => {
    const j = ledgerJournal(pindarou, {
      lines: [line('gross', 50000), line('FOODY_BAMBOO', 3000), line('FOODY_CHOPSTICKS', 2000)],
      expenses: [],
      countedCents: 45000,
    });
    expect(journalBalances(j)).toBe(true);
    const foody = j.filter((l) => l.details.startsWith('FOODY'));
    expect(foody.map((l) => l.cents)).toEqual([3000, 2000]);
    expect(foody[0]!.details).toContain('Bamboo');
    expect(j.some((l) => l.kind === 'short' || l.kind === 'over')).toBe(false);
  });

  it('exports a named line under the name the manager wrote', () => {
    const key = customLineKey('ΝΙΜΑ');
    const j = ledgerJournal(anamma, {
      lines: [line('gross', 20000), line(key, 5000, 'ΝΙΜΑ')],
      expenses: [],
      countedCents: 15000,
    });
    expect(j.find((l) => l.rowKey === key)?.details).toBe('ΝΙΜΑ');
    expect(journalBalances(j)).toBe(true);
  });

  it('still exports a retired row when an old night carries it', () => {
    const j = ledgerJournal(anamma, {
      lines: [line('gross', 20000), line('card1', 5000)],
      expenses: [],
      countedCents: 15000,
    });
    expect(j.find((l) => l.rowKey === 'card1')?.cents).toBe(5000);
    expect(journalBalances(j)).toBe(true);
  });

  it('leaves out empty rows', () => {
    const j = ledgerJournal(anamma, {
      lines: [line('gross', 20000), line('WOLT', 0)],
      expenses: [],
      countedCents: 20000,
    });
    expect(j.map((l) => l.kind)).toEqual(['sales', 'cash']);
  });
});

describe('ledgerJournal, envelope below zero', () => {
  it('credits a negative envelope and still balances', () => {
    // €1.000 takings, €400 on cards, €620 paid out of the till: the
    // envelope is €20 down, made up at the next close-out.
    const j = ledgerJournal(anamma, {
      lines: [line('gross', 100000), line('card2', 40000)],
      expenses: [{ description: null, supplierName: 'ΛΑΙΚΗ', invoiceNumber: '', amountCents: 62000 }],
      countedCents: -2000,
    });
    expect(journalBalances(j)).toBe(true);
    expect(j.find((l) => l.kind === 'cash')).toMatchObject({ sign: 'C', cents: 2000 });
    expect(j.every((l) => l.cents > 0)).toBe(true);
    expect(j.some((l) => l.kind === 'short' || l.kind === 'over')).toBe(false);
  });
});

describe('shiftsJournal', () => {
  it('sums the shifts into one day and balances', () => {
    const j = shiftsJournal(chinaSpice, {
      shifts: [
        { totalCents: 30000, payments: [{ methodKey: 'CASH', amountCents: 10000 }, { methodKey: 'GAP', amountCents: 20000 }] },
        { totalCents: 50000, payments: [{ methodKey: 'CASH', amountCents: 25000 }, { methodKey: 'GAP', amountCents: 15000 }, { methodKey: 'WOLT', amountCents: 10000 }] },
      ],
      invoices: [{ supplierName: 'ΚΡΕΑΤΑ', invoiceNumber: '77', amountCents: 2000 }],
    });
    expect(journalBalances(j)).toBe(true);
    expect(j[0]).toMatchObject({ sign: 'C', cents: 80000 });
    expect(j.find((l) => l.rowKey === 'GAP')).toMatchObject({ cents: 35000, details: 'SIX CARDS' });
    expect(j.find((l) => l.kind === 'cash')?.cents).toBe(35000);
    // 80000 − 45000 non-cash = 35000 expected; 35000 cash + 2000 invoices → 2000 over.
    expect(j.at(-1)).toMatchObject({ sign: 'C', kind: 'over', cents: 2000 });
  });

  it('names a written-in method by what was written', () => {
    const key = customLineKey('ΝΙΜΑ');
    const j = shiftsJournal(chinaSpice, {
      shifts: [{ totalCents: 10000, payments: [{ methodKey: key, amountCents: 4000 }, { methodKey: 'CASH', amountCents: 6000 }] }],
      invoices: [],
    });
    expect(j.find((l) => l.rowKey === key)?.details).toBe('ΝΙΜΑ');
    expect(journalBalances(j)).toBe(true);
  });
});

describe('shiftsJournal, CASH below zero', () => {
  it('credits a negative day of cash and still balances', () => {
    const j = shiftsJournal(chinaSpice, {
      shifts: [
        { totalCents: 30000, payments: [{ methodKey: 'CASH', amountCents: -1900 }, { methodKey: 'GAP', amountCents: 30000 }] },
      ],
      invoices: [{ supplierName: 'ΚΡΕΑΤΑ', invoiceNumber: '77', amountCents: 1900 }],
    });
    expect(journalBalances(j)).toBe(true);
    expect(j.find((l) => l.kind === 'cash')).toMatchObject({ sign: 'C', cents: 1900 });
    expect(j.every((l) => l.cents > 0)).toBe(true);
  });
});

describe('Sofia row format', () => {
  it('writes amounts with a dot and two decimals', () => {
    expect(sofiaAmount(40807)).toBe('408.07');
    expect(sofiaAmount(5)).toBe('0.05');
    expect(sofiaAmount(123456789)).toBe('1234567.89');
  });

  it('writes dates the way the template does', () => {
    expect(sofiaDate('2026-09-04')).toBe('4/9/2026');
    expect(sofiaPeriod('2026-09-04')).toBe('09/2026');
  });

  it('keeps the reference within fifteen characters', () => {
    for (const id of ['anamma', 'chop_engomi', 'chop_pindarou', 'chop_cyprus', 'china_spice']) {
      expect(sofiaReference(id, '2026-09-14').length).toBeLessThanOrEqual(15);
    }
    expect(sofiaReference('anamma', '2026-09-14')).toBe('ZET-ANM-140926');
  });

  it('puts every line in the template columns and ends with the marker row', () => {
    const j = ledgerJournal(anamma, { lines: [line('gross', 10000)], expenses: [], countedCents: 10000 });
    const rows = toSofiaRows('anamma', '2026-09-14', j);
    expect(rows).toHaveLength(j.length + 1);
    for (const r of rows) expect(r).toHaveLength(SOFIA_COLUMN_COUNT);
    expect(rows[0]!.slice(0, 14)).toEqual([
      'CBS', 'JV', '09/2026', '', 'ZET-ANM-140926', '14/9/2026', 'C', 'EUR', '1.0000',
      '100.00', '0', '100.00', '0', 'DAILY REPORT TOTAL',
    ]);
    expect(rows.at(-1)![0]).toBe('**********');
    expect(rows.at(-1)!.slice(1).every((c) => c === '')).toBe(true);
  });
});
