import { describe, expect, it } from 'vitest';
import {
  clearShiftsDraft,
  draftStorageKey,
  readShiftsDraft,
  sameShiftsFields,
  writeShiftsDraft,
  type ShiftsDraftFields,
} from './shiftsDraft';

function blankColumn() {
  return { dineIn: '', ta: '', total: '', methods: {} };
}

function blankFields(): ShiftsDraftFields {
  return {
    businessDate: '',
    closingManagerName: '',
    signature: '',
    shifts: [blankColumn(), blankColumn(), blankColumn()],
    // One list for the night, not one per column (migration 0005).
    invoices: [],
  };
}

/** A real Storage-shaped in-memory stand-in — no jsdom needed. */
function makeMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    _store: store,
  };
}

describe('sameShiftsFields', () => {
  it('is true for two identical blank sheets', () => {
    expect(sameShiftsFields(blankFields(), blankFields())).toBe(true);
  });

  it('is false once one amount in one column differs', () => {
    const a = blankFields();
    const b = blankFields();
    b.shifts[1]!.total = '2592,90';
    expect(sameShiftsFields(a, b)).toBe(false);
  });

  it('is false once one payment method differs', () => {
    const a = blankFields();
    const b = blankFields();
    b.shifts[0]!.methods.JCC = '1437,58';
    expect(sameShiftsFields(a, b)).toBe(false);
  });

  it('is false once an invoice line differs', () => {
    const a = blankFields();
    const b = blankFields();
    b.shifts[1]!.invoices = [
      { supplier: 'SKLAVENITIS', invoiceNumber: '01/601277', amount: '5,40' },
    ];
    expect(sameShiftsFields(a, b)).toBe(false);
  });

  it('a date that merely defaults to today is not, by itself, a difference', () => {
    const a = blankFields();
    const b = blankFields();
    a.businessDate = '2026-09-24';
    b.businessDate = '2026-09-24';
    expect(sameShiftsFields(a, b)).toBe(true);
  });
});

describe('write then read', () => {
  it('reads back exactly what was written, plus a savedAt', () => {
    const storage = makeMemoryStorage();
    const fields = blankFields();
    fields.businessDate = '2026-09-10';
    fields.closingManagerName = 'Μανώλης';
    fields.shifts[1] = {
      dineIn: '',
      ta: '',
      total: '2592,90',
      methods: { CASH: '408,00', JCC: '1437,58', FOODY: '251,80', WOLT: '255,10' },
    };
    // One list for the night, not one per column (migration 0005).
    fields.invoices = [
      { supplier: 'SKLAVENITIS', invoiceNumber: '01/601277', amount: '5,40' },
      { supplier: 'A.SAVVIDES TYRES', invoiceNumber: 'ES266231', amount: '130,00' },
    ];

    writeShiftsDraft(storage, 'china_spice', fields, new Date(1_700_000_000_000));
    const read = readShiftsDraft(storage, 'china_spice');

    expect(read).not.toBeNull();
    expect(read!.savedAt).toBe(1_700_000_000_000);
    const { savedAt, ...rest } = read!;
    expect(rest).toEqual(fields);
  });

  it('still reads a draft written before invoices moved to the night', () => {
    const storage = makeMemoryStorage();
    // Exactly the old shape: invoices on the column, none on the night.
    storage.setItem(
      draftStorageKey('china_spice'),
      JSON.stringify({
        businessDate: '2026-09-10',
        closingManagerName: 'Μανώλης',
        signature: '',
        savedAt: 1_700_000_000_000,
        shifts: [
          {
            dineIn: '',
            ta: '',
            total: '2592,90',
            methods: { CASH: '408,00' },
            invoices: [{ supplier: 'SKLAVENITIS', invoiceNumber: '01/601277', amount: '5,40' }],
          },
        ],
      })
    );

    const read = readShiftsDraft(storage, 'china_spice');

    // Rejecting it would silently discard a sheet someone was halfway
    // through — the validator requiring the new shape did exactly that.
    expect(read).not.toBeNull();
    expect(read!.shifts[0]!.invoices?.[0]?.supplier).toBe('SKLAVENITIS');
  });

  it('keeps a draft written before named rows existed', () => {
    const storage = makeMemoryStorage();
    storage.setItem(
      draftStorageKey('china_spice'),
      JSON.stringify({
        businessDate: '2026-09-10',
        closingManagerName: 'Μανώλης',
        signature: '',
        savedAt: 1_700_000_000_000,
        shifts: [{ dineIn: '', ta: '', total: '2592,90', methods: { CASH: '408,00' } }],
        invoices: [],
        // no customLines key at all
      })
    );

    // Absent is a VERSION, not damage. This is the same mistake that once
    // made the validator throw away every new draft on the sheet.
    const read = readShiftsDraft(storage, 'china_spice');
    expect(read).not.toBeNull();
    expect(read!.customLines).toBeUndefined();
  });

  it('is restaurant-scoped: writing one restaurant never leaks into another', () => {
    const storage = makeMemoryStorage();
    writeShiftsDraft(storage, 'china_spice', blankFields());
    expect(readShiftsDraft(storage, 'anamma')).toBeNull();
  });

  it('clearShiftsDraft removes exactly that restaurant key', () => {
    const storage = makeMemoryStorage();
    writeShiftsDraft(storage, 'china_spice', blankFields());
    clearShiftsDraft(storage, 'china_spice');
    expect(readShiftsDraft(storage, 'china_spice')).toBeNull();
  });
});

describe('readShiftsDraft returns null rather than throwing, for', () => {
  it('no key written yet', () => {
    expect(readShiftsDraft(makeMemoryStorage(), 'china_spice')).toBeNull();
  });

  it('corrupt JSON', () => {
    const storage = makeMemoryStorage();
    storage.setItem(draftStorageKey('china_spice'), '{not json');
    expect(readShiftsDraft(storage, 'china_spice')).toBeNull();
  });

  it('valid JSON of the wrong shape', () => {
    const storage = makeMemoryStorage();
    storage.setItem(draftStorageKey('china_spice'), JSON.stringify({ hello: 'world' }));
    expect(readShiftsDraft(storage, 'china_spice')).toBeNull();
  });

  it('a LEDGER draft stored under the same key — wrong sheet, not a shifts draft', () => {
    const storage = makeMemoryStorage();
    storage.setItem(
      draftStorageKey('china_spice'),
      JSON.stringify({
        businessDate: '2026-09-14',
        closingManagerName: 'x',
        signature: 'x',
        values: { gross: '2165,00' },
        labels: {},
        slots: {},
        expenses: [],
        cheques: [],
        pendingReceipts: [],
        counted: '408,07',
        savedAt: 1,
      })
    );
    expect(readShiftsDraft(storage, 'china_spice')).toBeNull();
  });

  it('a shifts column whose invoices is not a list', () => {
    // A column with NO invoices key is valid now — that is the shape every
    // draft written since invoices moved to the night has. What must still
    // be rejected is a key of the wrong type, which is corruption rather
    // than an older version.
    const storage = makeMemoryStorage();
    storage.setItem(
      draftStorageKey('china_spice'),
      JSON.stringify({
        businessDate: '',
        closingManagerName: '',
        signature: '',
        savedAt: 1,
        shifts: [{ dineIn: '', ta: '', total: '', methods: {}, invoices: 'nope' }],
      })
    );
    expect(readShiftsDraft(storage, 'china_spice')).toBeNull();
  });

  it('a night whose invoices is not a list', () => {
    const storage = makeMemoryStorage();
    storage.setItem(
      draftStorageKey('china_spice'),
      JSON.stringify({
        businessDate: '',
        closingManagerName: '',
        signature: '',
        savedAt: 1,
        shifts: [{ dineIn: '', ta: '', total: '', methods: {} }],
        invoices: { supplier: 'not a list' },
      })
    );
    expect(readShiftsDraft(storage, 'china_spice')).toBeNull();
  });

  it('a night whose customLines is not a list', () => {
    const storage = makeMemoryStorage();
    storage.setItem(
      draftStorageKey('china_spice'),
      JSON.stringify({
        businessDate: '',
        closingManagerName: '',
        signature: '',
        savedAt: 1,
        shifts: [{ dineIn: '', ta: '', total: '', methods: {} }],
        invoices: [],
        customLines: 'NIMA',
      })
    );
    expect(readShiftsDraft(storage, 'china_spice')).toBeNull();
  });

  it('a named row whose amounts are not strings', () => {
    const storage = makeMemoryStorage();
    storage.setItem(
      draftStorageKey('china_spice'),
      JSON.stringify({
        businessDate: '',
        closingManagerName: '',
        signature: '',
        savedAt: 1,
        shifts: [{ dineIn: '', ta: '', total: '', methods: {} }],
        invoices: [],
        customLines: [{ label: 'ΝΙΜΑ', amounts: [5220] }],
      })
    );
    expect(readShiftsDraft(storage, 'china_spice')).toBeNull();
  });

  it('storage.getItem itself throwing (private mode, cleared site data)', () => {
    const throwing = {
      getItem() {
        throw new DOMException('denied');
      },
    };
    expect(readShiftsDraft(throwing, 'china_spice')).toBeNull();
  });
});

describe('writes never throw', () => {
  it('writeShiftsDraft swallows a throwing setItem', () => {
    const throwing = {
      setItem() {
        throw new DOMException('quota');
      },
    };
    expect(() => writeShiftsDraft(throwing, 'china_spice', blankFields())).not.toThrow();
  });

  it('clearShiftsDraft swallows a throwing removeItem', () => {
    const throwing = {
      removeItem() {
        throw new DOMException('denied');
      },
    };
    expect(() => clearShiftsDraft(throwing, 'china_spice')).not.toThrow();
  });
});
