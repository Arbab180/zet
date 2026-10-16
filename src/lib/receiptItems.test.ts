import { describe, expect, it } from 'vitest';
import {
  MAX_RECEIPT_ITEMS,
  itemsDifference,
  itemsForEdit,
  itemsForPayload,
  itemsFromDb,
  itemsToDbJson,
  itemsTotalCents,
  normaliseItems,
  storedItemsTotalCents,
} from './receiptItems';
import { formatCents } from './money';

describe('normaliseItems', () => {
  it('turns anything that is not a list into no items', () => {
    // A draft from before items existed has no key; a damaged one could
    // hold anything. Neither may stop the sheet from opening.
    for (const v of [undefined, null, 'x', 3, {}]) expect(normaliseItems(v)).toEqual([]);
  });

  it('fills in missing fields and drops entries that are not objects', () => {
    expect(normaliseItems([{ name: 'A' }, null, 'x', { amount: '1,00', qty: 2 }])).toEqual([
      { name: 'A', qty: '', amount: '' },
      { name: '', qty: '', amount: '1,00' },
    ]);
  });

  it('never returns more than the cap', () => {
    const many = Array.from({ length: MAX_RECEIPT_ITEMS + 20 }, () => ({ name: 'x' }));
    expect(normaliseItems(many)).toHaveLength(MAX_RECEIPT_ITEMS);
  });
});

describe('itemsForPayload', () => {
  it('sends touched lines only, trimmed', () => {
    expect(
      itemsForPayload([
        { name: ' Ντομάτες ', qty: ' 5 kg', amount: ' 12,50 ' },
        { name: '', qty: '  ', amount: '' },
        { name: '', qty: '', amount: '3,00' },
      ])
    ).toEqual([
      { name: 'Ντομάτες', qty: '5 kg', amount: '12,50' },
      { name: '', qty: '', amount: '3,00' },
    ]);
  });
});

describe('adding items up', () => {
  const items = [
    { name: 'A', qty: '', amount: '12,50' },
    { name: 'B', qty: '', amount: '1.234,00' },
    { name: 'C', qty: '', amount: '' },
  ];

  it('adds the priced lines and ignores the unpriced', () => {
    expect(itemsTotalCents(items)).toBe(1250 + 123400);
  });

  it('reports a difference from the receipt amount without changing either', () => {
    expect(itemsDifference(items, '1.250,00')).toEqual({
      itemsCents: 124650,
      lineCents: 125000,
      differenceCents: 350,
    });
    expect(itemsDifference(items, '1.246,50')?.differenceCents).toBe(0);
  });

  it('has nothing to compare when no item is priced or the line has no amount', () => {
    expect(itemsDifference([{ name: 'A', qty: '', amount: '' }], '5,00')).toBeNull();
    expect(itemsDifference(items, '  ')).toBeNull();
    expect(itemsDifference([], '5,00')).toBeNull();
  });
});

describe('the stored shape', () => {
  it('stores no items as nothing', () => {
    expect(itemsToDbJson([])).toBe('');
  });

  it('round-trips, keeping "no price" apart from zero', () => {
    const items = [
      { name: 'Ντομάτες', qty: '5 kg', amountCents: 1250 },
      { name: 'Δώρο', qty: '1', amountCents: 0 },
      { name: 'Σακούλα', qty: '', amountCents: null },
    ];
    const json = itemsToDbJson(items);
    expect(JSON.parse(json)[0]).toEqual({ name: 'Ντομάτες', qty: '5 kg', amount_cents: 1250 });
    // As text, and as the already-parsed value the pg driver hands back.
    expect(itemsFromDb(json)).toEqual(items);
    expect(itemsFromDb(JSON.parse(json))).toEqual(items);
    expect(storedItemsTotalCents(items)).toBe(1250);
  });

  it('reads NULL, rubbish and odd rows as safely as it can', () => {
    expect(itemsFromDb(null)).toEqual([]);
    expect(itemsFromDb('not json')).toEqual([]);
    expect(itemsFromDb({ a: 1 })).toEqual([]);
    expect(itemsFromDb([{ name: 'A', amount_cents: -5 }, 7])).toEqual([
      { name: 'A', qty: '', amountCents: null },
    ]);
  });

  it('hands the form strings, with an empty box for no price and 0,00 for free', () => {
    expect(
      itemsForEdit(
        [
          { name: 'A', qty: '2', amountCents: 1250 },
          { name: 'B', qty: '', amountCents: null },
          { name: 'C', qty: '', amountCents: 0 },
        ],
        formatCents
      )
    ).toEqual([
      { name: 'A', qty: '2', amount: '12,50' },
      { name: 'B', qty: '', amount: '' },
      { name: 'C', qty: '', amount: '0,00' },
    ]);
  });
});
