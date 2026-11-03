import { describe, it, expect } from 'vitest';
import {
  parseCents,
  parsePrintedCents,
  formatCents,
  sanitizeAmountInput,
  sanitizeSignedAmountInput,
  amountDisplay,
  rawFromEdit,
} from './money';

describe('parseCents', () => {
  // These cases come from real sheets. The "1.234" row is the one that matters:
  // it is the bug that recorded EUR 1.234,00 as EUR 1,23.
  const cases: Array<[string, number]> = [
    ['2165,00', 216500],
    ['1.640,33', 164033],
    ['1640.33', 164033],
    ['1.234', 123400],
    ['12.34', 1234],
    ['1.2', 120],
    ['123.456', 12345600],
    ['1.234.567', 123456700],
    ['1234', 123400],
    ['0,5', 50],
    ['1,234', 123400],
    ['5', 500],
    ['408,07', 40807],
    ['2.592,90', 259290],
    ['', 0],
    ['   ', 0],
    ['€ 1.000,00', 100000],
  ];

  it.each(cases)('parses %s to %i cents', (input, expected) => {
    expect(parseCents(input)).toBe(expected);
  });

  it('returns 0 for nonsense rather than NaN', () => {
    expect(parseCents('abc')).toBe(0);
    expect(parseCents(null)).toBe(0);
    expect(parseCents(undefined)).toBe(0);
  });
});

describe('formatCents', () => {
  it('formats in Greek convention', () => {
    expect(formatCents(40807)).toBe('408,07');
    expect(formatCents(164033)).toBe('1.640,33');
    expect(formatCents(0)).toBe('0,00');
  });
});

describe('sanitizeAmountInput', () => {
  it('keeps digits and separators, drops everything else', () => {
    expect(sanitizeAmountInput('12abc')).toBe('12');
    expect(sanitizeAmountInput('1.234,56')).toBe('1.234,56');
  });
});

describe('negative envelope cash', () => {
  it('reads a leading minus in either convention', () => {
    expect(parseCents('-19')).toBe(-1900);
    expect(parseCents('-19,50')).toBe(-1950);
    expect(parseCents('-1.234')).toBe(-123400);
    expect(parseCents(' -€ 5,00')).toBe(-500);
  });
  it('treats a lone minus as nothing typed yet', () => {
    expect(parseCents('-')).toBe(0);
    expect(Object.is(parseCents('-0'), -0)).toBe(false);
  });
  it('keeps one leading minus in the cash box only', () => {
    expect(sanitizeSignedAmountInput('-19,5')).toBe('-19,5');
    expect(sanitizeSignedAmountInput('1-9')).toBe('19');
    expect(sanitizeSignedAmountInput('--19')).toBe('-19');
    expect(sanitizeAmountInput('-19')).toBe('19');
  });
});

describe('plain numbers are read as typed (auto decimals removed 03/11/2026)', () => {
  it.each([
    ['5', 500],
    ['194', 19400],
    ['1990', 199000],
    ['12345', 1234500],
    ['19,90', 1990],
    ['19.90', 1990],
    ['1.990', 199000],
    ['-1990', -199000],
    ['-19,29', -1929],
  ] as Array<[string, number]>)('reads %s as %i cents', (input, expected) => {
    expect(parseCents(input)).toBe(expected);
  });

  it('shows what was typed, with nothing added', () => {
    expect(amountDisplay('1990')).toBe('1990');
    expect(rawFromEdit('199', '1990')).toBe('1990');
  });

  it('keeps a minus typed into the cash box', () => {
    expect(sanitizeSignedAmountInput(rawFromEdit('', '-'))).toBe('-');
    expect(rawFromEdit('-', '-19,29')).toBe('-19,29');
  });
});
