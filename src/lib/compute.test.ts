import { describe, it, expect } from 'vitest';
import { computeLedger, computeShift, slotsAgree, linesAgree } from './compute';
import { ANAMMA, CHOPSTICKS_ENGOMI, CHOPSTICKS_PINDAROU, CHINA_SPICE } from './forms';
import { parseCents as c } from './money';

/**
 * Every fixture below is a real sheet. If one of these fails, the maths is
 * wrong — not the fixture.
 */

describe('ledger sheets reconcile to the paper', () => {
  it('ΤΟ ΑΝΑΜΜΑ 14/09/26 -> 408,07', () => {
    const t = computeLedger(ANAMMA, {
      values: { gross: c('2165,00'), card1: c('1.640,33'), FOODY: c('84,80'), WOLT: c('31,80') },
      expenses: [],
      countedCents: c('408,07'),
    });
    expect(t.expectedCents).toBe(c('408,07'));
    expect(t.varianceCents).toBe(0);
    expect(t.subtotals.afterCards).toBe(c('524,67'));
  });

  it('CHOPSTICKS Engomi 14/09/26 -> 72,09', () => {
    // NOTE: only balances with BOLT at 137,10. Read as 127,10 the sheet is
    // out by 10 euro — either a misread digit or an error nobody caught.
    const t = computeLedger(CHOPSTICKS_ENGOMI, {
      values: {
        gross: c('740,04'), card1: c('180,84'), FOODY: c('214,98'),
        WOLT: c('130,73'), BOLT: c('137,10'), other1: c('4,30'), // "Kiosk"
      },
      expenses: [],
      countedCents: c('72,09'),
    });
    expect(t.expectedCents).toBe(c('72,09'));
    expect(t.varianceCents).toBe(0);
  });

  it('CHOPSTICKS Πινδάρου 10/09/26 -> 18,61', () => {
    // WOLT reads 146,13 on the sheet but only the 127,75 "ONLINE" part is
    // deducted; the 18,38 collected in cash stays in the till. See the open
    // question about modelling that split.
    const t = computeLedger(CHOPSTICKS_PINDAROU, {
      values: { gross: c('763,36'), FOODY: c('517,70'), WOLT: c('127,75'), BOLT: c('99,30') },
      expenses: [],
      countedCents: c('18,61'),
    });
    expect(t.expectedCents).toBe(c('18,61'));
    expect(t.varianceCents).toBe(0);
  });

  it('subtracts day expenses from the cash', () => {
    const t = computeLedger(ANAMMA, {
      values: { gross: c('1000,00') },
      expenses: [{ description: 'Λαχανικά', cents: c('25,50') }],
      countedCents: c('974,50'),
    });
    expect(t.expensesCents).toBe(c('25,50'));
    expect(t.expectedCents).toBe(c('974,50'));
    expect(t.varianceCents).toBe(0);
  });
});

describe('CHINA SPICE shift', () => {
  it('ΒΡΑΔΥ 10/09/26 -> expected 648,42, accounted 543,40', () => {
    const t = computeShift(CHINA_SPICE, {
      dineInCents: 0,
      taCents: 0,
      totalCents: c('2.592,90'),
      methods: { CASH: c('408,00'), JCC: c('1.437,58'), FOODY: c('251,80'), WOLT: c('255,10') },
      invoices: [
        { description: 'SKLAVENITIS 01/601277', cents: c('5,40') },
        { description: 'A.SAVVIDES TYRES ES266231', cents: c('130,00') },
      ],
    });
    expect(t.expectedCents).toBe(c('648,42'));
    expect(t.accountedCents).toBe(c('543,40'));
    // the sheet carries a circled handwritten "EUR 105" marked unpaid
    expect(t.differenceCents).toBe(c('105,02'));
    expect(t.splitMismatch).toBe(false);
  });

  it('flags Dine in + T/A not adding to Total', () => {
    const t = computeShift(CHINA_SPICE, {
      dineInCents: c('100,00'), taCents: c('50,00'), totalCents: c('200,00'),
      methods: {}, invoices: [],
    });
    expect(t.splitMismatch).toBe(true);
  });
});

describe('agreement helpers', () => {
  it('slots agree when empty or when they add up', () => {
    expect(slotsAgree(undefined, c('84,80'))).toBe(true);
    expect(slotsAgree([0, 0, 0], c('84,80'))).toBe(true);
    expect(slotsAgree([c('40,00'), c('44,80')], c('84,80'))).toBe(true);
    expect(slotsAgree([c('40,00')], c('84,80'))).toBe(false);
  });

  it('itemised lines agree with their row', () => {
    expect(linesAgree([], c('30,00'))).toBe(true);
    expect(linesAgree([{ cents: c('20,00') }], c('20,00'))).toBe(true);
    expect(linesAgree([{ cents: c('20,00') }], c('30,00'))).toBe(false);
  });
});
