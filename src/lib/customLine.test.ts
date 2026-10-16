import { describe, expect, it } from 'vitest';
import {
  CUSTOM_LINE_PREFIX,
  MAX_CUSTOM_LABEL,
  customLineKey,
  duplicateLabel,
  isCustomLineKey,
  labelFromCustomKey,
  normaliseCustomLabel,
} from './customLine';
import { FORMS, FORM_ORDER } from './forms';

describe('the reserved prefix', () => {
  // The whole design rests on this: the label IS the stored method_key.
  // If a configured method ever started with the prefix, a named row and
  // a real payment method would collide on UNIQUE (shift_id, method_key)
  // and one night's figure would overwrite the other.
  it('collides with no configured method on any sheet', () => {
    for (const id of FORM_ORDER) {
      const form = FORMS[id];
      if (form.layout !== 'shifts') continue;
      for (const m of form.methods) {
        expect(isCustomLineKey(m.key)).toBe(false);
      }
    }
  });

  it('survives a round trip through the key', () => {
    expect(labelFromCustomKey(customLineKey('ΝΙΜΑ'))).toBe('ΝΙΜΑ');
  });

  it('leaves a configured key alone when asked for its label', () => {
    expect(labelFromCustomKey('SKASH')).toBe('SKASH');
  });

  it('puts the prefix on the front', () => {
    expect(customLineKey('ΝΙΜΑ')).toBe(`${CUSTOM_LINE_PREFIX}ΝΙΜΑ`);
  });
});

describe('normalising a label', () => {
  it('collapses the whitespace a phone keyboard leaves behind', () => {
    expect(normaliseCustomLabel('  ΝΙΜΑ   ΔΥΟ ')).toBe('ΝΙΜΑ ΔΥΟ');
  });

  it('keeps the case the person typed, because the accountant reads it', () => {
    expect(normaliseCustomLabel('Nima')).toBe('Nima');
  });

  it('is empty for a box holding only spaces', () => {
    expect(normaliseCustomLabel('   ')).toBe('');
  });

  it('caps the length', () => {
    expect(normaliseCustomLabel('Χ'.repeat(200))).toHaveLength(MAX_CUSTOM_LABEL);
  });
});

describe('duplicate labels', () => {
  // Two rows called Nima and NIMA are one row to the person filling the
  // sheet; letting both through would split one platform's takings.
  it('are caught regardless of case', () => {
    expect(duplicateLabel(['Nima', 'NIMA'])).toBe('NIMA');
  });

  it('are caught across different spacing', () => {
    expect(duplicateLabel(['ΝΙΜΑ ΔΥΟ', ' ΝΙΜΑ  ΔΥΟ '])).toBe('ΝΙΜΑ ΔΥΟ');
  });

  it('ignores the blank spare rows, of which there is always one', () => {
    expect(duplicateLabel(['', '', 'ΝΙΜΑ'])).toBeNull();
  });

  it('passes distinct names', () => {
    expect(duplicateLabel(['ΝΙΜΑ', 'ΕΦΚΑ'])).toBeNull();
  });
});
