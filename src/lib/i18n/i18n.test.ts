import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EN } from './en';
import { makeT, parseLang, translate } from './index';
import * as messages from '../messages';
import { FORMS } from '../forms';
import { describeFlag } from '../flags';
import {
  MSG_SAVE_NO_RESPONSE,
  MSG_SAVE_OFFLINE,
  MSG_SAVE_PHOTO_STILL_UPLOADING,
} from '../../components/saveOutcome';

const GREEK = /[Ͱ-Ͽἀ-῿]/;
const en = makeT('en');

/** Every .ts/.tsx file under src, tests excluded. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/**
 * The literal text of every t('…') call, including t('a ' + 'b').
 * A call on a variable (t(row.label)) is checked by the tests below
 * that walk the configs and messages instead.
 */
function literalCalls(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const call = /\bt\(\s*((?:'(?:[^'\\]|\\.)*'\s*\+?\s*)+)[,)]/g;
  for (const file of sourceFiles(join(__dirname, '..', '..'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(call)) {
      const parts = [...m[1]!.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((p) =>
        p[1]!.replace(/\\'/g, "'")
      );
      out.push({ file, text: parts.join('') });
    }
  }
  return out;
}

describe('translate', () => {
  it('leaves Greek alone in Greek', () => {
    expect(translate('el', 'Ημερομηνία')).toBe('Ημερομηνία');
    expect(translate('el', 'αναθεώρηση {n}', { n: 2 })).toBe('αναθεώρηση 2');
  });

  it('translates exact text and fills placeholders', () => {
    expect(en('Ημερομηνία')).toBe('Date');
    expect(en('αναθεώρηση {n}', { n: 2 })).toBe('revision 2');
  });

  it('passes through text it does not know', () => {
    expect(en('SIX CARDS')).toBe('SIX CARDS');
    expect(en('Λήδρας 87, Λευκωσία')).toBe('Λήδρας 87, Λευκωσία');
    expect(en('')).toBe('');
  });

  it('translates text that arrives already filled in', () => {
    expect(en(messages.missingHeader(1))).toBe('Not saved — 1 thing is missing');
    expect(en(messages.missingHeader(3))).toBe('Not saved — 3 things are missing');
    expect(en(messages.MSG_PDF_NO_ROOM(2, 5))).toBe(
      '2 of 5 pages went in — there were no more lines. Enter the rest by hand.'
    );
    expect(en(messages.MSG_ITEMS_COUNT(4))).toBe('4 items');
  });

  it('translates a flag, including the row name inside it', () => {
    const fmt = (c: number) => `€${(c / 100).toFixed(2)}`;
    expect(en(describeFlag({ kind: 'cash_variance', amountCents: 420 }, fmt))).toBe(
      'Cash does not balance: difference €4.20'
    );
    expect(
      en(
        describeFlag(
          { kind: 'slots_disagree', amountCents: 100, rowKey: 'FOODY', rowLabel: 'FOODY ΟΛΙΚΟ' },
          fmt
        )
      )
    ).toBe("FOODY TOTAL: the orders don't add up to the total — difference €1.00");
  });

  it('reads the cookie value safely', () => {
    expect(parseLang('en')).toBe('en');
    expect(parseLang('el')).toBe('el');
    expect(parseLang('fr')).toBe('el');
    expect(parseLang(undefined)).toBe('el');
  });
});

describe('the English catalogue', () => {
  it('has English for every t(…) call in the code', () => {
    // A guard on the guard: if the scan finds nothing, it checks nothing.
    expect(literalCalls().length).toBeGreaterThan(150);
    const missing = literalCalls()
      .filter(({ text }) => GREEK.test(text) && en(text) === text)
      .map(({ file, text }) => `${file.split('/src/')[1]}: ${text}`);
    expect(missing).toEqual([]);
  });

  it('has English for every message the app can show', () => {
    const samples: string[] = [
      MSG_SAVE_OFFLINE,
      MSG_SAVE_NO_RESPONSE,
      MSG_SAVE_PHOTO_STILL_UPLOADING,
    ];
    for (const value of Object.values(messages)) {
      if (typeof value === 'string') samples.push(value);
      if (typeof value === 'function') {
        samples.push(String((value as (...a: unknown[]) => unknown)(2, 3, '€1,00')));
        samples.push(String((value as (...a: unknown[]) => unknown)(1, 1, '€1,00')));
      }
    }
    const missing = samples.filter((s) => GREEK.test(s) && GREEK.test(en(s)));
    expect(missing).toEqual([]);
  });

  it('has English for every Greek word printed on a sheet', () => {
    const printed: string[] = [];
    for (const form of Object.values(FORMS)) {
      if (form.tagline) printed.push(form.tagline);
      if (form.layout === 'ledger') {
        printed.push(form.cashLabel, form.expensesHeading, ...form.expenseColumns);
        for (const row of form.rows) {
          printed.push(row.label);
          if (row.kind === 'input' && row.note) printed.push(row.note);
          if (row.kind === 'group') printed.push(...row.children.map((c) => c.label));
        }
      } else {
        printed.push(...form.shifts, ...form.tameioRows.map((r) => r.label));
        printed.push(...form.methods.map((m) => m.label));
      }
    }
    const missing = printed.filter((s) => GREEK.test(s) && GREEK.test(en(s)));
    expect(missing).toEqual([]);
  });

  it('keeps the same {placeholders} on both sides, and no Greek in the English', () => {
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [greek, english] of Object.entries(EN)) {
      expect(names(english), greek).toEqual(names(greek));
      expect(GREEK.test(english), english).toBe(false);
    }
  });
});
