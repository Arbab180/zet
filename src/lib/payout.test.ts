import { describe, expect, it } from 'vitest';
import { comparePayout, datesBetween, statementBalances, type PayoutStatement } from './payout';

/** The real Foody statement for Chopsticks Mall of Cyprus, 21–27/09/2026:
 *  total received 3.140,70, invoice 760,73, payable 2.379,97. */
function statement(over: Partial<PayoutStatement> = {}): PayoutStatement {
  return {
    platform: 'FOODY',
    venueCode: 'CY_FD_2719_2719',
    invoiceNumber: '025000683771',
    periodFrom: '2026-09-21',
    periodTo: '2026-09-27',
    grossReceivedCents: 314070,
    feesCents: 76073,
    payableCents: 237997,
    ...over,
  };
}

const week = [
  '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24',
  '2026-09-25', '2026-09-26', '2026-09-27',
];

describe('the period', () => {
  it('is every night inclusive of both ends', () => {
    expect(datesBetween('2026-09-21', '2026-09-27')).toEqual(week);
  });

  it('is one night when the statement covers a day', () => {
    expect(datesBetween('2026-09-21', '2026-09-21')).toEqual(['2026-09-21']);
  });

  it('does not fall over on a malformed date', () => {
    expect(datesBetween('nonsense', '2026-09-27')).toEqual([]);
  });
});

describe('the statement agreeing with itself', () => {
  // These figures are READ OFF A SCAN. A misread digit would otherwise
  // surface as a discrepancy blamed on the restaurant.
  it('passes on the real one', () => {
    expect(statementBalances(statement())).toBe(true);
  });

  it('fails when gross less fees is not what it says is payable', () => {
    expect(statementBalances(statement({ payableCents: 200000 }))).toBe(false);
  });
});

describe('a week where every night was filed', () => {
  it('reconciles to nothing when the sheets add up to the statement', () => {
    // 3.140,70 spread across seven nights.
    const nights = week.map((d, i) => ({
      businessDate: d,
      recordedCents: i === 0 ? 314070 - 6 * 44867 : 44867,
    }));
    const result = comparePayout(statement(), nights);
    expect(result.differenceCents).toBe(0);
    expect(result.comparable).toBe(true);
    expect(result.nightsWithSheet).toBe(7);
  });

  it('reports the shortfall when the sheets claimed more than was collected', () => {
    // Cancelled orders: the sheets say 3.173,10, Foody collected 3.140,70.
    const nights = week.map((d, i) => ({
      businessDate: d,
      recordedCents: i === 0 ? 317310 - 6 * 44867 : 44867,
    }));
    const result = comparePayout(statement(), nights);
    expect(result.differenceCents).toBe(3240);
    expect(result.comparable).toBe(true);
  });
});

describe('a week with a night missing', () => {
  // The failure that would make this feature lie: three nights unfiled
  // looks exactly like three nights of orders that never got paid.
  it('is not comparable, however large the difference looks', () => {
    const nights = week.slice(0, 4).map((d) => ({ businessDate: d, recordedCents: 44867 }));
    const result = comparePayout(statement(), nights);
    expect(result.comparable).toBe(false);
    expect(result.nightsWithSheet).toBe(4);
    expect(result.missingDates).toEqual(['2026-09-25', '2026-09-26', '2026-09-27']);
  });

  it('still returns the difference, as context rather than a verdict', () => {
    const nights = week.slice(0, 4).map((d) => ({ businessDate: d, recordedCents: 44867 }));
    expect(comparePayout(statement(), nights).differenceCents).toBe(4 * 44867 - 314070);
  });

  it('treats a night with no sheet differently from a night of zero', () => {
    const zeroed = week.map((d) => ({ businessDate: d, recordedCents: 0 }));
    const result = comparePayout(statement(), zeroed);
    expect(result.comparable).toBe(true);
    expect(result.missingDates).toEqual([]);
    expect(result.differenceCents).toBe(-314070);
  });
});

describe('a statement that does not balance', () => {
  it('is not comparable — that is a bad read, not a bad night', () => {
    const nights = week.map((d) => ({ businessDate: d, recordedCents: 44867 }));
    const result = comparePayout(statement({ payableCents: 1 }), nights);
    expect(result.comparable).toBe(false);
  });
});

describe('with the per-order appendix', () => {
  const orders = [
    { orderDate: '2026-09-21', reference: '1039773093', receivedCents: 2620 },
    { orderDate: '2026-09-21', reference: '1039773186', receivedCents: 2680 },
    // A cash order Foody did NOT collect: it went into the till, so it is
    // 0,00 here and must not be expected in the platform row either.
    { orderDate: '2026-09-21', reference: '1039788032', receivedCents: 0 },
    { orderDate: '2026-09-22', reference: '1039798321', receivedCents: 2390 },
  ];

  it('says which night drifted, not just the week', () => {
    const result = comparePayout(
      statement({ grossReceivedCents: 7690, orders }),
      [
        { businessDate: '2026-09-21', recordedCents: 5300 },
        { businessDate: '2026-09-22', recordedCents: 2390 },
        ...week.slice(2).map((d) => ({ businessDate: d, recordedCents: 0 })),
      ]
    );
    const first = result.days?.find((d) => d.businessDate === '2026-09-21');
    expect(first?.statementCents).toBe(5300);
    expect(first?.differenceCents).toBe(0);
    const second = result.days?.find((d) => d.businessDate === '2026-09-22');
    expect(second?.differenceCents).toBe(0);
  });

  it('leaves a night with no sheet without a difference', () => {
    const result = comparePayout(statement({ grossReceivedCents: 7690, orders }), []);
    expect(result.days?.every((d) => d.differenceCents === null)).toBe(true);
  });
});
