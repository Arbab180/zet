import { describe, expect, it } from 'vitest';
import { FORMS, rowLabelFor, rowOrderFor, type LedgerForm, type ShiftsForm } from './forms';
import { computeLedger, computeShift } from './compute';
import { journalBalances, ledgerJournal, shiftsJournal } from './sofiaExport';
import {
  CARD_BRACKETS_GROUP_KEY,
  MAX_CARD_BRACKETS,
  cardBracketCount,
  filledCardBrackets,
  removeCardBracket,
  withAllCardBrackets,
  withCardBrackets,
  withoutHiddenBrackets,
} from './cardMachines';

const anamma = FORMS.anamma as LedgerForm;
const montparnasse = FORMS.china_spice as ShiftsForm;

const line = (rowKey: string, amountCents: number) => ({ rowKey, labelOverride: null, amountCents });

describe('no brackets', () => {
  it('leaves every sheet exactly as it was', () => {
    for (const form of Object.values(FORMS)) expect(withCardBrackets(form, 0)).toBe(form);
  });

  it('every sheet has the live card row the brackets split', () => {
    for (const form of Object.values(FORMS)) {
      if (form.layout === 'ledger') {
        expect(form.rows.some((r) => r.kind === 'input' && r.key === form.cardRowKey && !r.retired)).toBe(true);
      } else {
        expect(form.methods.some((m) => m.key === form.cardRowKey && !m.retired)).toBe(true);
      }
    }
  });
});

describe('how many brackets', () => {
  it('is the highest CARD_n, within the ceiling', () => {
    expect(cardBracketCount(['gross', 'CARD_1', 'CARD_3'])).toBe(3);
    expect(cardBracketCount(['CARD_0', 'CARD_01', `CARD_${MAX_CARD_BRACKETS + 1}`, 'CARD_x'])).toBe(0);
  });

  it('opens a sheet with the brackets that hold a figure, not every blank one read back', () => {
    expect(filledCardBrackets({ CARD_1: '10', CARD_2: '5', CARD_3: '', CARD_12: ' ' })).toBe(2);
  });

  it('posts only the brackets on screen', () => {
    expect(withoutHiddenBrackets({ gross: '1', CARD_1: '2', CARD_2: '3' }, 1)).toEqual({ gross: '1', CARD_1: '2' });
  });

  it('removing one moves the ones after it up, so the numbers stay 1…n', () => {
    const v = { gross: '9', CARD_1: '10', CARD_2: '20', CARD_3: '30' };
    expect(removeCardBracket(v, 3, 2)).toEqual({ gross: '9', CARD_1: '10', CARD_2: '30' });
    expect(removeCardBracket(v, 3, 3)).toEqual({ gross: '9', CARD_1: '10', CARD_2: '20' });
    expect(removeCardBracket({ CARD_1: '10' }, 1, 1)).toEqual({});
  });
});

describe('a ledger sheet with two brackets', () => {
  const form = withCardBrackets(anamma, 2);

  it('turns SIX CARDS into a total over brackets 1 and 2, in the same place', () => {
    const at = form.rows.findIndex((r) => r.key === CARD_BRACKETS_GROUP_KEY);
    expect(form.rows[at - 1]).toMatchObject({ key: 'card2', retired: true });
    expect(form.rows[at]).toMatchObject({
      kind: 'group',
      label: 'SIX CARDS',
      sign: '−',
      countsAs: 'card2',
      children: [
        { key: 'CARD_1', label: '1' },
        { key: 'CARD_2', label: '2' },
      ],
    });
    expect(form.rows[at + 1]).toMatchObject({ kind: 'subtotal', key: 'afterCards' });
  });

  it('deducts the brackets once, exactly as one SIX CARDS figure of their sum did', () => {
    const base = { expenses: [], countedCents: 0 };
    const split = computeLedger(form, { ...base, values: { gross: 216500, CARD_1: 100000, CARD_2: 64033 } });
    const plain = computeLedger(anamma, { ...base, values: { gross: 216500, card2: 164033 } });
    expect(split).toEqual(plain);
  });

  it('names a bracket with its row, and sorts it there', () => {
    expect(rowLabelFor(form, 'CARD_2')).toBe('SIX CARDS — 2');
    expect(rowOrderFor(form, 'CARD_1')).toBeLessThan(rowOrderFor(form, 'FOODY'));
    expect(rowOrderFor(form, 'CARD_1')).toBeGreaterThan(rowOrderFor(form, 'gross'));
  });
});

describe('the Sofia export still posts one card line', () => {
  const form = withAllCardBrackets(anamma) as LedgerForm;

  it('posts the brackets as SIX CARDS, for their sum — the same journal as before', () => {
    const j = ledgerJournal(form, {
      lines: [line('gross', 100000), line('card2', 0), line('CARD_1', 25000), line('CARD_2', 15000), line('WOLT', 10000)],
      expenses: [],
      countedCents: 50000,
    });
    expect(journalBalances(j)).toBe(true);
    expect(j).toEqual(
      ledgerJournal(anamma, {
        lines: [line('gross', 100000), line('card2', 40000), line('WOLT', 10000)],
        expenses: [],
        countedCents: 50000,
      })
    );
  });

  it('folds an old SIX CARDS figure and the brackets into one line, whichever comes first', () => {
    for (const lines of [
      [line('gross', 100000), line('card2', 5000), line('CARD_1', 25000)],
      [line('gross', 100000), line('CARD_1', 25000), line('card2', 5000)],
    ]) {
      const j = ledgerJournal(form, { lines, expenses: [], countedCents: 70000 });
      expect(j.filter((l) => l.rowKey === 'card2')).toEqual([
        expect.objectContaining({ cents: 30000, details: 'SIX CARDS' }),
      ]);
      expect(journalBalances(j)).toBe(true);
      expect(j.some((l) => l.kind === 'short' || l.kind === 'over')).toBe(false);
    }
  });

  it('leaves the Pindarou Foody parts as two lines — only card brackets are folded', () => {
    const j = ledgerJournal(withAllCardBrackets(FORMS.chop_pindarou) as LedgerForm, {
      lines: [line('gross', 10000), line('FOODY_BAMBOO', 1000), line('FOODY_CHOPSTICKS', 2000)],
      expenses: [],
      countedCents: 7000,
    });
    expect(j.filter((l) => l.kind === 'deduction')).toHaveLength(2);
  });
});

describe('Montparnasse (shifts) with two brackets', () => {
  const form = withCardBrackets(montparnasse, 2);

  it('retires the SIX CARDS row and lists the brackets right under it', () => {
    const at = form.methods.findIndex((x) => x.key === 'GAP');
    expect(form.methods[at]).toMatchObject({ key: 'GAP', retired: true });
    expect(form.methods.slice(at + 1, at + 3)).toEqual([
      { key: 'CARD_1', label: '1', countsAs: 'GAP' },
      { key: 'CARD_2', label: '2', countsAs: 'GAP' },
    ]);
    expect(rowLabelFor(form, 'CARD_1')).toBe('SIX CARDS — 1');
  });

  it('counts each bracket as card money, so the cash expected is unchanged', () => {
    const entry = { dineInCents: 0, taCents: 0, totalCents: 100000, invoices: [] };
    const split = computeShift(form, { ...entry, methods: { CASH: 40000, CARD_1: 35000, CARD_2: 25000 } });
    const plain = computeShift(montparnasse, { ...entry, methods: { CASH: 40000, GAP: 60000 } });
    expect(split).toEqual(plain);
  });

  it('exports one SIX CARDS line, summed across brackets and shifts', () => {
    const j = shiftsJournal(withAllCardBrackets(montparnasse) as ShiftsForm, {
      shifts: [
        { totalCents: 50000, payments: [{ methodKey: 'CASH', amountCents: 20000 }, { methodKey: 'CARD_1', amountCents: 30000 }] },
        { totalCents: 50000, payments: [{ methodKey: 'CASH', amountCents: 20000 }, { methodKey: 'CARD_2', amountCents: 10000 }, { methodKey: 'CARD_1', amountCents: 20000 }] },
      ],
      invoices: [],
    });
    expect(journalBalances(j)).toBe(true);
    expect(j.filter((l) => l.kind === 'deduction')).toEqual([
      { sign: 'D', cents: 60000, details: 'SIX CARDS', kind: 'deduction', rowKey: 'GAP' },
    ]);
  });
});
