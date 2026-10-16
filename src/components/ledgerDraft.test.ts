import { describe, expect, it, vi } from 'vitest';
import {
  clearDraft,
  defaultBusinessDate,
  draftStorageKey,
  readDraft,
  sameDraftFields,
  todayLocalDateString,
  writeDraft,
  type LedgerDraftFields,
} from './ledgerDraft';

function blankFields(): LedgerDraftFields {
  return {
    businessDate: '',
    closingManagerName: '',
    signature: '',
    values: {},
    labels: {},
    slots: {},
    expenses: [{ description: '', amount: '' }],
    cheques: [],
    pendingReceipts: [],
    counted: '',
  };
}

/** A real Storage-shaped in-memory stand-in — no jsdom needed. */
function makeMemoryStorage() {
  const store = new Map<string, string>();
  return {
    store,
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void store.set(key, value)),
    removeItem: vi.fn((key: string) => void store.delete(key)),
  };
}

describe('draftStorageKey', () => {
  it('is scoped per restaurant', () => {
    expect(draftStorageKey('anamma')).not.toBe(draftStorageKey('chop_engomi'));
    expect(draftStorageKey('anamma')).toContain('anamma');
  });
});

describe('sameDraftFields', () => {
  it('is true for two identical blank snapshots', () => {
    expect(sameDraftFields(blankFields(), blankFields())).toBe(true);
  });

  it('is false once a single field differs, at any depth', () => {
    expect(sameDraftFields(blankFields(), { ...blankFields(), businessDate: '2026-09-20' })).toBe(
      false
    );
    expect(
      sameDraftFields(blankFields(), { ...blankFields(), values: { gross: '100,00' } })
    ).toBe(false);
    expect(
      sameDraftFields(blankFields(), {
        ...blankFields(),
        cheques: [{ amount: '10,00', customerName: '', customerPhone: '', chequeNumber: '', bank: '' }],
      })
    ).toBe(false);
  });

  it('a date that merely defaults to today is not, by itself, a difference from that same default', () => {
    // The dirty check is a pure comparison; "today" only matters to the
    // caller that decides what counts as the starting baseline.
    const withToday = { ...blankFields(), businessDate: '2026-09-23' };
    expect(sameDraftFields(withToday, { ...withToday })).toBe(true);
  });
});

describe('write/read/clear round trip', () => {
  it('reads back exactly what was written, plus a savedAt', () => {
    const storage = makeMemoryStorage();
    const fields = { ...blankFields(), businessDate: '2026-09-20', counted: '408,07' };

    writeDraft(storage, 'anamma', fields, new Date('2026-09-20T23:10:00Z'));
    const read = readDraft(storage, 'anamma');

    expect(read).not.toBeNull();
    expect(sameDraftFields(read!, fields)).toBe(true);
    expect(read!.savedAt).toBe(new Date('2026-09-20T23:10:00Z').getTime());
  });

  it('is restaurant-scoped: writing one restaurant never leaks into another', () => {
    const storage = makeMemoryStorage();
    writeDraft(storage, 'anamma', { ...blankFields(), businessDate: '2026-09-20' });
    expect(readDraft(storage, 'chop_engomi')).toBeNull();
  });

  it('clearDraft removes exactly that restaurant’s key', () => {
    const storage = makeMemoryStorage();
    writeDraft(storage, 'anamma', blankFields());
    writeDraft(storage, 'chop_engomi', blankFields());

    clearDraft(storage, 'anamma');

    expect(readDraft(storage, 'anamma')).toBeNull();
    expect(readDraft(storage, 'chop_engomi')).not.toBeNull();
  });
});

describe('readDraft — every failure mode returns null, never throws', () => {
  it('no key written yet', () => {
    const storage = makeMemoryStorage();
    expect(readDraft(storage, 'anamma')).toBeNull();
  });

  it('corrupt JSON', () => {
    const storage = makeMemoryStorage();
    storage.store.set(draftStorageKey('anamma'), '{not json');
    expect(readDraft(storage, 'anamma')).toBeNull();
  });

  it('valid JSON but the wrong shape (an old format, or something else entirely)', () => {
    const storage = makeMemoryStorage();
    storage.store.set(draftStorageKey('anamma'), JSON.stringify({ hello: 'world' }));
    expect(readDraft(storage, 'anamma')).toBeNull();
  });

  it('storage.getItem itself throwing (private mode, cleared site data)', () => {
    const storage = makeMemoryStorage();
    storage.getItem.mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readDraft(storage, 'anamma')).toBeNull();
  });
});

describe('writeDraft and clearDraft never throw even when storage does', () => {
  it('writeDraft swallows a throwing setItem', () => {
    const storage = makeMemoryStorage();
    storage.setItem.mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => writeDraft(storage, 'anamma', blankFields())).not.toThrow();
  });

  it('clearDraft swallows a throwing removeItem', () => {
    const storage = makeMemoryStorage();
    storage.removeItem.mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => clearDraft(storage, 'anamma')).not.toThrow();
  });
});

describe('todayLocalDateString', () => {
  it('formats as YYYY-MM-DD from local calendar fields, zero-padded', () => {
    expect(todayLocalDateString(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(todayLocalDateString(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('uses local date fields, not UTC — a UTC-based read would be wrong near midnight', () => {
    const local = new Date(2026, 8, 20); // 20 September 2026, local midnight
    expect(todayLocalDateString(local)).toBe('2026-09-20');
  });
});

describe('defaultBusinessDate — the night being closed, not "today"', () => {
  /** Local time: the trading day is local, never UTC. */
  const at = (y: number, m: number, d: number, h: number, min = 0) =>
    new Date(y, m - 1, d, h, min);

  it('23:45 is that same night', () => {
    expect(defaultBusinessDate(at(2026, 9, 24, 23, 45))).toBe('2026-09-24');
  });

  it('01:30 is still the night that just closed, not the calendar day', () => {
    expect(defaultBusinessDate(at(2026, 9, 25, 1, 30))).toBe('2026-09-24');
  });

  it('04:59 is still the previous night; 05:00 is the new day', () => {
    expect(defaultBusinessDate(at(2026, 9, 25, 4, 59))).toBe('2026-09-24');
    expect(defaultBusinessDate(at(2026, 9, 25, 5, 0))).toBe('2026-09-25');
  });

  it('rolls back over a month boundary', () => {
    expect(defaultBusinessDate(at(2026, 9, 1, 1, 0))).toBe('2026-08-31');
  });

  it('rolls back over a year boundary', () => {
    expect(defaultBusinessDate(at(2026, 1, 1, 2, 0))).toBe('2025-12-31');
  });

  it('handles a leap day, and the year that has none', () => {
    expect(defaultBusinessDate(at(2028, 3, 1, 1, 0))).toBe('2028-02-29');
    expect(defaultBusinessDate(at(2027, 3, 1, 1, 0))).toBe('2027-02-28');
  });

  it('does not mutate the date it is given', () => {
    const given = at(2026, 9, 25, 1, 0);
    defaultBusinessDate(given);
    expect(given.getDate()).toBe(25);
  });
});
