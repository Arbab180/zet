import { describe, it, expect } from 'vitest';
import {
  parseCents,
  parsePrintedCents,
  formatCents,
  sanitizeAmountInput,
  sanitizeSignedAmountInput,
  flipSign,
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
    // Was 123400 until 30/10/2026: four digits or more with no comma or
    // dot now means the last two are cents (see 'auto decimal' below).
    ['1234', 1234],
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
  it('flips the sign with the ± button', () => {
    expect(flipSign('19,50')).toBe('-19,50');
    expect(flipSign('-19,50')).toBe('19,50');
    expect(flipSign('')).toBe('-');
    expect(flipSign('-')).toBe('');
  });
});

describe('auto decimal (Arbab, 30/10/2026)', () => {
  it.each([
    ['5', 500],
    ['50', 5000],
    ['194', 19400],
    ['1946', 1946],
    ['12345', 12345],
    ['194600', 194600],
    ['0050', 50],
    ['0,5', 50],
    ['19,46', 1946],
    ['1946,', 194600],
    ['1.946', 194600],
    ['1946.00', 194600],
    ['-1946', -1946],
    ['-19', -1900],
  ] as Array<[string, number]>)('reads %s as %i cents', (input, expected) => {
    expect(parseCents(input)).toBe(expected);
  });

  it('never applies to a figure read off a printed receipt', () => {
    expect(parsePrintedCents('1500')).toBe(150000);
  });

  it('shows the comma as the digits are typed', () => {
    expect(amountDisplay('1')).toBe('1');
    expect(amountDisplay('19')).toBe('19');
    expect(amountDisplay('194')).toBe('194');
    expect(amountDisplay('1946')).toBe('19,46');
    expect(amountDisplay('12345')).toBe('123,45');
    expect(amountDisplay('1234567')).toBe('12.345,67');
    expect(amountDisplay('-1946')).toBe('-19,46');
    expect(amountDisplay('19,5')).toBe('19,5');
    expect(amountDisplay('')).toBe('');
  });

  it('turns each keystroke on the shown text back into the digits typed', () => {
    // typing 1 9 4 6 5, one key at a time
    let raw = '';
    for (const key of '19465') raw = rawFromEdit(raw, amountDisplay(raw) + key);
    expect(raw).toBe('19465');
    expect(amountDisplay(raw)).toBe('194,65');
    // backspace
    const shown = amountDisplay(raw);
    raw = rawFromEdit(raw, shown.slice(0, -1));
    expect(raw).toBe('1946');
    raw = rawFromEdit(raw, amountDisplay(raw).slice(0, -1));
    expect(raw).toBe('194');
    expect(amountDisplay(raw)).toBe('194');
  });

  it('keeps a comma the manager types after the digits', () => {
    expect(rawFromEdit('1946', '19,46,')).toBe('1946,');
    expect(amountDisplay('1946,')).toBe('1946,');
    expect(parseCents('1946,50')).toBe(194650);
  });

  it('keeps the minus through the shown text', () => {
    expect(rawFromEdit('-1946', '-19,465')).toBe('-19465');
    expect(flipSign('1946')).toBe('-1946');
  });
});
