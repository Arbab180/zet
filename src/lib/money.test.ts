import { describe, it, expect } from 'vitest';
import { parseCents, formatCents, sanitizeAmountInput } from './money';

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
