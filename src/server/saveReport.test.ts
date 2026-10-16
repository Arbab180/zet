/**
 * The save action, against a mocked `pg` — same approach as db.test.ts, and
 * for the same reason: what is under test here is decision-making and
 * statement ORDER, neither of which needs a live database. The SQL itself is
 * proved against real Postgres 16 by db/probe_action.sql.
 *
 * The four fixtures are the real sheets from compute.test.ts, pushed through
 * the whole action as a manager's phone would post them — strings, exactly
 * as typed. If one of these fails the action is wrong, not the fixture.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockConnect = vi.fn();

vi.mock('pg', () => ({
  // A function, not an arrow: db.ts calls `new Pool(...)`, and since
  // vitest 4 a mock is only constructible if its implementation is.
  Pool: vi.fn().mockImplementation(function () {
    return { connect: mockConnect };
  }),
}));

const USER = '11111111-1111-1111-1111-111111111111';
const REPORT = '33333333-3333-3333-3333-333333333333';

function session(overrides: { userId?: string; expiresAt?: Date } = {}) {
  return {
    userId: overrides.userId ?? USER,
    expiresAt: overrides.expiresAt ?? new Date('2030-01-01T00:00:00Z'),
  };
}

interface MockOptions {
  /** What restaurant_user returns for this user. null = not a member. */
  role?: string | null;
  /** An already-stored report for this (restaurant, business_date). */
  existing?: { id: string; status: string; revision_no: number } | null;
}

function makeMockClient(options: MockOptions = {}) {
  const { role = 'manager', existing = null } = options;
  let currentUserId: string | null = null;

  /** Every statement, in the order it was issued. */
  const statements: Array<{ sql: string; params: unknown[] }> = [];

  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params: params ?? [] });

    if (sql.includes('pg_roles')) {
      return { rows: [{ rolname: 'zet_app', rolsuper: false, rolbypassrls: false }] };
    }
    if (sql.includes('pg_class')) return { rows: [{ owner: 'zet_owner' }] };
    if (sql.includes('set_config')) {
      currentUserId = (params?.[0] as string | undefined) ?? null;
      return { rows: [] };
    }
    if (sql.includes('current_setting')) return { rows: [{ uid: currentUserId }] };
    if (sql.includes('SELECT role FROM restaurant_user')) {
      return { rows: role === null ? [] : [{ role }] };
    }
    if (sql.includes('FOR UPDATE')) return { rows: existing ? [existing] : [] };

    // More specific table names first: "INSERT INTO zet_report_line" also
    // contains "INSERT INTO zet_report".
    if (sql.includes('INSERT INTO zet_report_line')) {
      const keys = (params?.[1] ?? []) as string[];
      return { rows: keys.map((k, i) => ({ id: `line-${i}`, row_key: k })) };
    }
    if (sql.includes('INSERT INTO zet_shift\n')) {
      const indexes = (params?.[1] ?? []) as number[];
      return { rows: indexes.map((i) => ({ id: `shift-${i}`, shift_index: i })) };
    }
    if (sql.includes('INSERT INTO zet_report\n')) {
      return { rows: [{ id: REPORT, revision_no: 1, status: params?.[2] }] };
    }
    if (sql.includes('UPDATE zet_report SET')) {
      if (sql.includes('revision_no = revision_no + 1')) {
        return { rows: [{ revision_no: (existing?.revision_no ?? 1) + 1, status: params?.[3] }] };
      }
      if (sql.includes("status = 'approved'")) {
        return { rows: [{ revision_no: existing?.revision_no ?? 1, status: 'approved' }] };
      }
      return { rows: [{ revision_no: existing?.revision_no ?? 1, status: params?.[1] }] };
    }
    return { rows: [] };
  });

  return { query, release: vi.fn(), statements };
}

/** db.ts caches its role-safety check per module instance, so import fresh. */
async function freshAction(options: MockOptions = {}) {
  vi.resetModules();
  const client = makeMockClient(options);
  mockConnect.mockResolvedValue(client);
  const mod = await import('./saveReport');
  return { ...mod, client };
}

/** Index of the first statement matching `needle`, or -1. */
function indexOf(client: { statements: Array<{ sql: string }> }, needle: string): number {
  return client.statements.findIndex((s) => s.sql.includes(needle));
}

function paramsOf(client: { statements: Array<{ sql: string; params: unknown[] }> }, needle: string) {
  return client.statements.find((s) => s.sql.includes(needle))?.params;
}

const REQUIRED = {
  closingManagerName: 'Μαρία Γεωργίου',
  signature: 'data:image/png;base64,iVBORw0KGgo=',
};

beforeEach(() => {
  mockConnect.mockReset();
});

// ── The real sheets ───────────────────────────────────────────────────────

describe('the four fixtures reconcile through the action', () => {
  it('ΤΟ ΑΝΑΜΜΑ 14/09/26 -> expected 408,07', async () => {
    const { saveDailyReport, client } = await freshAction();

    const result = await saveDailyReport(
      {
        restaurantId: 'anamma',
        businessDate: '2026-09-14',
        ...REQUIRED,
        ledger: {
          values: { gross: '2165,00', card1: '1.640,33', FOODY: '84,80', WOLT: '31,80' },
          counted: '408,07',
        },
      },
      { session: session() }
    );

    expect(result).toMatchObject({
      ok: true,
      expectedCents: 40807,
      actualCents: 40807,
      varianceCents: 0,
    });

    // What was actually handed to Postgres, not just what was returned:
    // expected_cents is $7 and actual_cents is $8 on the INSERT.
    const insert = paramsOf(client, 'INSERT INTO zet_report\n');
    expect(insert?.[6]).toBe(40807);
    expect(insert?.[7]).toBe(40807);

    // And the per-row cents, including the 1.640,33 that a naive parser
    // would read as one euro sixty-four.
    const lines = paramsOf(client, 'INSERT INTO zet_report_line');
    const keys = lines?.[1] as string[];
    const amounts = lines?.[3] as number[];
    expect(amounts[keys.indexOf('gross')]).toBe(216500);
    expect(amounts[keys.indexOf('card1')]).toBe(164033);
    expect(amounts[keys.indexOf('FOODY')]).toBe(8480);
    expect(amounts[keys.indexOf('WOLT')]).toBe(3180);
  });

  it('CHOPSTICKS Engomi 14/09/26 -> expected 72,09, with the hand-written Kiosk row', async () => {
    const { saveDailyReport, client } = await freshAction();

    const result = await saveDailyReport(
      {
        restaurantId: 'chop_engomi',
        businessDate: '2026-09-14',
        ...REQUIRED,
        ledger: {
          values: {
            gross: '740,04', card1: '180,84', FOODY: '214,98',
            WOLT: '130,73', BOLT: '137,10', other1: '4,30',
          },
          labels: { other1: 'Kiosk' },
          counted: '72,09',
        },
      },
      { session: session() }
    );

    expect(result).toMatchObject({ ok: true, expectedCents: 7209, varianceCents: 0 });

    const lines = paramsOf(client, 'INSERT INTO zet_report_line');
    const keys = lines?.[1] as string[];
    const labels = lines?.[2] as Array<string | null>;
    expect(labels[keys.indexOf('other1')]).toBe('Kiosk');
    // Every other row's label is printed on the paper, so nothing overrides it.
    expect(labels[keys.indexOf('gross')]).toBeNull();
  });

  it('CHOPSTICKS Πινδάρου 10/09/26 -> expected 18,61', async () => {
    const { saveDailyReport } = await freshAction();

    const result = await saveDailyReport(
      {
        restaurantId: 'chop_pindarou',
        businessDate: '2026-09-10',
        ...REQUIRED,
        ledger: {
          values: { gross: '763,36', FOODY: '517,70', WOLT: '127,75', BOLT: '99,30' },
          counted: '18,61',
        },
      },
      { session: session() }
    );

    expect(result).toMatchObject({ ok: true, expectedCents: 1861, varianceCents: 0 });
  });

  it('CHINA SPICE ΒΡΑΔΥ 10/09/26 -> expected 648,42, accounted 543,40', async () => {
    const { saveDailyReport, client } = await freshAction();

    const result = await saveDailyReport(
      {
        restaurantId: 'china_spice',
        businessDate: '2026-09-10',
        ...REQUIRED,
        shifts: [
          {
            shiftIndex: 1,
            total: '2.592,90',
            methods: { CASH: '408,00', JCC: '1.437,58', FOODY: '251,80', WOLT: '255,10' },
          },
        ],
        // One list for the night (migration 0005). Only ΒΡΑΔΥ carried
        // figures that night, so the reconciled totals are unchanged:
        // 543,40 accounted, 105,02 short, matching the circled figure.
        invoices: [
          { supplier: 'SKLAVENITIS', invoiceNumber: '01/601277', amount: '5,40' },
          { supplier: 'A.SAVVIDES TYRES', invoiceNumber: 'ES266231', amount: '130,00' },
        ],
      },
      { session: session() }
    );

    expect(result).toMatchObject({
      ok: true,
      expectedCents: 64842,
      actualCents: 54340,
      // The sheet carries a circled handwritten "EUR 105" marked unpaid.
      // compute.ts's difference is expected - accounted; the stored variance
      // is actual - expected, so a shortage is negative. Same €105,02.
      varianceCents: -10502,
    });

    // The shift column keeps the form's own heading, not one the client sent.
    const shifts = paramsOf(client, 'INSERT INTO zet_shift\n');
    expect((shifts?.[2] as string[])[0]).toBe('ΒΡΑΔΥ');

    // Supplier and invoice number are stored apart — that pair is the join
    // into the AI invoicing project (SPEC.md §4).
    const invoices = paramsOf(client, 'INSERT INTO zet_report_invoice');
    expect(invoices?.[2]).toEqual(['SKLAVENITIS', 'A.SAVVIDES TYRES']);
    expect(invoices?.[3]).toEqual(['01/601277', 'ES266231']);
    expect(invoices?.[4]).toEqual([540, 13000]);
  });

  it('stores a shift invoice photo against its own line, not the one beside it', async () => {
    const { saveDailyReport, client } = await freshAction();

    // The middle line carries only a photo — nobody typed the supplier yet.
    // It must still reach the database, and the keys must stay aligned with
    // the lines they were taken for.
    const result = await saveDailyReport(
      {
        restaurantId: 'china_spice',
        businessDate: '2026-09-11',
        ...REQUIRED,
        shifts: [
          {
            shiftIndex: 1,
            total: '100,00',
            methods: { CASH: '100,00' },
          },
        ],
        invoices: [
          { supplier: 'SKLAVENITIS', invoiceNumber: '01/1', amount: '5,40', receiptPhotoUrl: '' },
          { supplier: '', invoiceNumber: '', amount: '', receiptPhotoUrl: 'china_spice/2026-09-11/b.jpg' },
          { supplier: 'TYRES', invoiceNumber: 'ES1', amount: '10,00', receiptPhotoUrl: 'china_spice/2026-09-11/c.jpg' },
        ],
      },
      { session: session() }
    );

    expect(result).toMatchObject({ ok: true });

    const invoices = paramsOf(client, 'INSERT INTO zet_report_invoice');
    expect(invoices?.[2]).toEqual(['SKLAVENITIS', '', 'TYRES']);
    // The photo column, in step with the suppliers above it. An earlier
    // version of the client built this array by mapping AFTER filtering out
    // blank lines, which renumbered them and slid every key one line up.
    expect(invoices?.[5]).toEqual([
      '',
      'china_spice/2026-09-11/b.jpg',
      'china_spice/2026-09-11/c.jpg',
    ]);
  });

  it('stores the supplier, invoice number and date off an expense receipt', async () => {
    const { saveDailyReport, client } = await freshAction();

    const result = await saveDailyReport(
      {
        restaurantId: 'anamma',
        businessDate: '2026-08-01',
        ...REQUIRED,
        ledger: {
          values: { gross: '100,00' },
          counted: '50,08',
          expenses: [
            {
              description: 'ψώνια',
              amount: '49,92',
              supplier: 'ALPHAMEGA',
              invoiceNumber: '163704',
              invoiceDate: '2026-08-01',
            },
          ],
        },
      },
      { session: session() }
    );

    expect(result).toMatchObject({ ok: true });

    const exp = paramsOf(client, 'INSERT INTO zet_expense_line');
    expect(exp?.[5]).toEqual(['ALPHAMEGA']);
    expect(exp?.[6]).toEqual(['163704']);
    expect(exp?.[7]).toEqual(['2026-08-01']);
  });

  it('drops a nonsense receipt date rather than losing the whole night', async () => {
    const { saveDailyReport, client } = await freshAction();

    // A misread year is the realistic failure: the date comes off a
    // photograph. The CHECK in migration 0004 would refuse the INSERT, and
    // refusing to record a night's takings over a scanned date would be
    // the tail wagging the dog. The amount must survive.
    const result = await saveDailyReport(
      {
        restaurantId: 'anamma',
        businessDate: '2026-08-01',
        ...REQUIRED,
        ledger: {
          values: { gross: '100,00' },
          counted: '50,08',
          expenses: [
            { amount: '49,92', supplier: 'ALPHAMEGA', invoiceDate: '1970-01-01' },
            { amount: '1,50', supplier: 'FRESH', invoiceDate: '2026-02-31' },
            { amount: '3,12', supplier: 'ΖΟΡΠΑΣ', invoiceDate: 'not a date' },
          ],
        },
      },
      { session: session() }
    );

    expect(result).toMatchObject({ ok: true });

    const exp = paramsOf(client, 'INSERT INTO zet_expense_line');
    expect(exp?.[3]).toEqual([4992, 150, 312]);
    expect(exp?.[5]).toEqual(['ALPHAMEGA', 'FRESH', 'ΖΟΡΠΑΣ']);
    // Out of range, a day that does not exist, and not a date at all.
    expect(exp?.[7]).toEqual(['', '', '']);
  });

  it('stores an invoice date against the right line of the night', async () => {
    const { saveDailyReport, client } = await freshAction();

    const result = await saveDailyReport(
      {
        restaurantId: 'china_spice',
        businessDate: '2026-08-01',
        ...REQUIRED,
        shifts: [
          {
            shiftIndex: 1,
            total: '100,00',
            methods: { CASH: '100,00' },
          },
        ],
        invoices: [
          { supplier: 'ΖΟΡΠΑΣ', invoiceNumber: '08S1', amount: '3,12', invoiceDate: '2026-08-01' },
          { supplier: 'BLUE ISLAND', invoiceNumber: '14678', amount: '7,06', invoiceDate: '' },
        ],
      },
      { session: session() }
    );

    expect(result).toMatchObject({ ok: true });

    const inv = paramsOf(client, 'INSERT INTO zet_report_invoice');
    expect(inv?.[2]).toEqual(['ΖΟΡΠΑΣ', 'BLUE ISLAND']);
    expect(inv?.[6]).toEqual(['2026-08-01', '']);
  });

  it("stores a receipt's items with its line, and keeps them out of the arithmetic", async () => {
    const { saveDailyReport, client } = await freshAction();

    const result = await saveDailyReport(
      {
        restaurantId: 'anamma',
        businessDate: '2026-08-01',
        ...REQUIRED,
        ledger: {
          values: { gross: '100,00' },
          counted: '50,08',
          expenses: [
            {
              description: 'ALPHAMEGA',
              amount: '49,92',
              // Deliberately NOT adding up to 49,92: a difference is shown
              // to the person, never settled, and never refuses a save.
              items: [
                { name: ' Ντομάτες ', qty: '5 kg', amount: '12,50' },
                { name: 'Σακούλα', qty: '', amount: '' },
                { name: '', qty: '', amount: '' },
              ],
            },
            { description: 'χωρίς είδη', amount: '1,00' },
          ],
        },
      },
      { session: session() }
    );

    expect(result).toMatchObject({ ok: true });

    const exp = paramsOf(client, 'INSERT INTO zet_expense_line');
    const stored = exp?.[8] as string[];
    expect(JSON.parse(stored[0]!)).toEqual([
      { name: 'Ντομάτες', qty: '5 kg', amount_cents: 1250 },
      // No price is stored as no price, not as zero. The blank third line
      // is not a line.
      { name: 'Σακούλα', qty: '', amount_cents: null },
    ]);
    // '' travels as "no items" and becomes NULL in the statement.
    expect(stored[1]).toBe('');
    // The line's own amount is untouched by what its items add up to.
    expect(exp?.[3]).toEqual([4992, 100]);
  });

  it('stores items against the right invoice of the night', async () => {
    const { saveDailyReport, client } = await freshAction();

    const result = await saveDailyReport(
      {
        restaurantId: 'china_spice',
        businessDate: '2026-08-01',
        ...REQUIRED,
        shifts: [{ shiftIndex: 1, total: '100,00', methods: { CASH: '100,00' } }],
        invoices: [
          { supplier: 'ΖΟΡΠΑΣ', invoiceNumber: '08S1', amount: '3,12' },
          {
            supplier: 'BLUE ISLAND',
            invoiceNumber: '14678',
            amount: '7,06',
            items: [{ name: 'Σολομός', qty: '1', amount: '7,06' }],
          },
        ],
      },
      { session: session() }
    );

    expect(result).toMatchObject({ ok: true });

    const inv = paramsOf(client, 'INSERT INTO zet_report_invoice');
    const stored = inv?.[7] as string[];
    expect(stored[0]).toBe('');
    expect(JSON.parse(stored[1]!)).toEqual([{ name: 'Σολομός', qty: '1', amount_cents: 706 }]);
  });

  it('refuses letters in an item amount rather than storing the item without a price', async () => {
    const { saveDailyReport } = await freshAction();

    const result = await saveDailyReport(
      {
        restaurantId: 'anamma',
        businessDate: '2026-08-01',
        ...REQUIRED,
        ledger: {
          values: { gross: '100,00' },
          counted: '100,00',
          expenses: [
            { description: 'x', amount: '1,00', items: [{ name: 'κάτι', qty: '', amount: 'abc' }] },
          ],
        },
      },
      { session: session() }
    );

    expect(result).toMatchObject({ ok: false, error: 'invalid_payload' });
  });

  it('reads 1.234 as one thousand two hundred thirty four, not one euro twenty-three', async () => {
    const { saveDailyReport } = await freshAction();

    const result = await saveDailyReport(
      {
        restaurantId: 'anamma',
        businessDate: '2026-09-14',
        ...REQUIRED,
        ledger: { values: { gross: '1.234' }, counted: '1.234' },
      },
      { session: session() }
    );

    expect(result).toMatchObject({ ok: true, expectedCents: 123400, actualCents: 123400 });
  });

  it('subtracts the expense block and stores each line', async () => {
    const { saveDailyReport, client } = await freshAction();

    const result = await saveDailyReport(
      {
        restaurantId: 'anamma',
        businessDate: '2026-09-14',
        ...REQUIRED,
        ledger: {
          values: { gross: '1000,00' },
          expenses: [{ description: 'Λαχανικά', amount: '25,50' }],
          counted: '974,50',
        },
      },
      { session: session() }
    );

    expect(result).toMatchObject({ ok: true, expectedCents: 97450, varianceCents: 0 });
    const expenses = paramsOf(client, 'INSERT INTO zet_expense_line');
    expect(expenses?.[1]).toEqual([1]);
    expect(expenses?.[3]).toEqual([2550]);
  });
});

// ── A posted total is rejected, not ignored ──────────────────────────────

describe('a total posted by the browser', () => {
  const base = {
    restaurantId: 'anamma',
    businessDate: '2026-09-14',
    ...REQUIRED,
    ledger: { values: { gross: '2165,00' }, counted: '408,07' },
  };

  it('rejects expected_cents', async () => {
    const { saveDailyReport } = await freshAction();
    const result = await saveDailyReport({ ...base, expected_cents: 1 }, { session: session() });
    expect(result).toMatchObject({ ok: false, error: 'posted_total' });
    expect((result as { details?: string[] }).details).toContain('payload.expected_cents');
  });

  it('rejects actual_cents and variance_cents', async () => {
    for (const key of ['actual_cents', 'variance_cents']) {
      const { saveDailyReport } = await freshAction();
      const result = await saveDailyReport({ ...base, [key]: 999999 }, { session: session() });
      expect(result).toMatchObject({ ok: false, error: 'posted_total' });
    }
  });

  it('rejects a total buried inside a nested line, not just at the top level', async () => {
    const { saveDailyReport } = await freshAction();
    const result = await saveDailyReport(
      {
        ...base,
        ledger: {
          values: { gross: '2165,00' },
          counted: '408,07',
          expenses: [{ description: 'Λαχανικά', amountCents: 2550 }],
        },
      },
      { session: session() }
    );
    expect(result).toMatchObject({ ok: false, error: 'posted_total' });
    expect((result as { details?: string[] }).details).toContain(
      'payload.ledger.expenses[0].amountCents'
    );
  });

  it('never opens a database connection for a payload carrying a total', async () => {
    const { saveDailyReport } = await freshAction();
    await saveDailyReport({ ...base, variance_cents: 0 }, { session: session() });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('still accepts the raw inputs whose names merely look like totals', async () => {
    // "counted" and "total" ARE raw inputs — what the manager counted, and
    // the ΤΑΜΕΙΟ Total printed on the shift column. Rejecting those would
    // break the sheet.
    const { saveDailyReport } = await freshAction();
    const result = await saveDailyReport(base, { session: session() });
    expect(result).toMatchObject({ ok: true });
  });
});

// ── Authorisation ─────────────────────────────────────────────────────────

describe('per-restaurant authorisation', () => {
  const base = {
    restaurantId: 'anamma',
    businessDate: '2026-09-14',
    ...REQUIRED,
    ledger: { values: { gross: '2165,00' }, counted: '408,07' },
  };

  it('refuses a user who is not a member of that restaurant, and writes nothing', async () => {
    const { saveDailyReport, client } = await freshAction({ role: null });

    const result = await saveDailyReport(base, { session: session() });

    expect(result).toMatchObject({ ok: false, error: 'not_authorised', reason: 'not_a_member' });
    expect(indexOf(client, 'INSERT INTO zet_report')).toBe(-1);
    expect(indexOf(client, 'UPDATE zet_report')).toBe(-1);
  });

  it('refuses a viewer', async () => {
    const { saveDailyReport, client } = await freshAction({ role: 'viewer' });
    const result = await saveDailyReport(base, { session: session() });
    expect(result).toMatchObject({ ok: false, error: 'not_authorised', reason: 'insufficient_role' });
    expect(indexOf(client, 'INSERT INTO zet_report')).toBe(-1);
  });

  it('allows staff, manager and admin', async () => {
    for (const role of ['staff', 'manager', 'admin']) {
      const { saveDailyReport } = await freshAction({ role });
      expect(await saveDailyReport(base, { session: session() })).toMatchObject({ ok: true });
    }
  });

  it('refuses a role the database returned that this code does not know', async () => {
    const { saveDailyReport } = await freshAction({ role: 'auditor' });
    const result = await saveDailyReport(base, { session: session() });
    expect(result).toMatchObject({ ok: false, error: 'not_authorised', reason: 'not_a_member' });
  });

  it('authorises on the open transaction, never a second connection', async () => {
    const { saveDailyReport, client } = await freshAction();
    await saveDailyReport(base, { session: session() });

    expect(mockConnect).toHaveBeenCalledTimes(1);
    // The role lookup happens inside the transaction, after BEGIN and after
    // zet.user_id is set — not before it, where RLS would empty it.
    expect(indexOf(client, 'SELECT role FROM restaurant_user')).toBeGreaterThan(
      indexOf(client, 'set_config')
    );
  });

  it('refuses with no session and with an expired one, without connecting', async () => {
    const none = await freshAction();
    expect(await none.saveDailyReport(base, { session: null })).toMatchObject({
      ok: false, error: 'not_authorised', reason: 'no_session',
    });

    const expired = await freshAction();
    expect(
      await expired.saveDailyReport(base, {
        session: session({ expiresAt: new Date('2020-01-01T00:00:00Z') }),
        now: new Date('2026-09-14T23:00:00Z'),
      })
    ).toMatchObject({ ok: false, error: 'not_authorised', reason: 'session_expired' });

    expect(mockConnect).not.toHaveBeenCalled();
  });
});

// ── SPEC.md §5 ────────────────────────────────────────────────────────────

describe('validation, which is deliberately almost none', () => {
  const ledger = { values: { gross: '2165,00' }, counted: '408,07' };

  it('names the three missing things in Greek, with a counted header', async () => {
    const { saveDailyReport } = await freshAction();
    const result = await saveDailyReport(
      { restaurantId: 'anamma', businessDate: '', closingManagerName: '', signature: '', ledger },
      { session: session() }
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'missing_fields',
      messages: ['Βάλτε ημερομηνία.', 'Γράψτε ποιος κλείνει το ταμείο.', 'Βάλτε υπογραφή.'],
      header: 'Δεν αποθηκεύτηκε — λείπουν 3 πράγματα',
    });
  });

  it('drops items from the live list as they are fixed, and is singular at one', async () => {
    const { saveDailyReport } = await freshAction();
    const result = await saveDailyReport(
      { restaurantId: 'anamma', businessDate: '2026-09-14', closingManagerName: 'Μαρία', signature: '', ledger },
      { session: session() }
    );
    expect(result).toMatchObject({
      ok: false,
      messages: ['Βάλτε υπογραφή.'],
      header: 'Δεν αποθηκεύτηκε — λείπει 1 πράγμα',
    });
  });

  it('rejects a date that is not a real day', async () => {
    const { saveDailyReport } = await freshAction();
    const result = await saveDailyReport(
      { restaurantId: 'anamma', businessDate: '2026-02-31', ...REQUIRED, ledger },
      { session: session() }
    );
    expect(result).toMatchObject({ ok: false, error: 'missing_fields', messages: ['Βάλτε ημερομηνία.'] });
  });

  it('lets a draft be saved without a manager or a signature', async () => {
    const { saveDailyReport } = await freshAction();
    const result = await saveDailyReport(
      { restaurantId: 'anamma', businessDate: '2026-09-14', status: 'draft', ledger },
      { session: session() }
    );
    expect(result).toMatchObject({ ok: true, status: 'draft' });
  });

  it('does not argue with the figures: a shortfall, and slots that disagree, both save', async () => {
    const { saveDailyReport } = await freshAction();
    const result = await saveDailyReport(
      {
        restaurantId: 'anamma',
        businessDate: '2026-09-14',
        ...REQUIRED,
        ledger: {
          values: { gross: '100,00', FOODY: '84,80' },
          // The order slots do not add up to FOODY's row, and the manager
          // counted less than the sheet expects. SPEC.md §5: shown, not blocked.
          slots: { FOODY: ['40,00', '1,00'] },
          counted: '10,00',
        },
      },
      { session: session() }
    );
    expect(result).toMatchObject({ ok: true, expectedCents: 1520, actualCents: 1000, varianceCents: -520 });
  });

  it('refuses letters in a money field rather than silently reading them as zero', async () => {
    const { saveDailyReport } = await freshAction();
    const result = await saveDailyReport(
      {
        restaurantId: 'anamma',
        businessDate: '2026-09-14',
        ...REQUIRED,
        ledger: { values: { gross: '2165,00 περίπου' }, counted: '408,07' },
      },
      { session: session() }
    );
    expect(result).toMatchObject({ ok: false, error: 'invalid_payload', messages: ['Μόνο αριθμοί'] });
  });

  it('refuses an amount too large to store exactly, which is not a ceiling on real days', async () => {
    const { saveDailyReport } = await freshAction();
    const huge = await saveDailyReport(
      {
        restaurantId: 'anamma',
        businessDate: '2026-09-14',
        ...REQUIRED,
        ledger: { values: { gross: '99999999999999999999' }, counted: '0' },
      },
      { session: session() }
    );
    expect(huge).toMatchObject({ ok: false, messages: ['Πολύ μεγάλο ποσό — ελέγξτε το.'] });

    // A genuinely big night still saves — there is no upper limit on amounts.
    const bigDay = await freshAction();
    expect(
      await bigDay.saveDailyReport(
        {
          restaurantId: 'anamma',
          businessDate: '2026-09-14',
          ...REQUIRED,
          ledger: { values: { gross: '250.000,00' }, counted: '250.000,00' },
        },
        { session: session() }
      )
    ).toMatchObject({ ok: true, expectedCents: 25_000_000 });
  });
});

// ── Identify by what it is, not what it is called ────────────────────────

describe('the layout is the restaurant’s, not the client’s', () => {
  it('refuses a shifts payload posted to a ledger restaurant', async () => {
    const { saveDailyReport } = await freshAction();
    const result = await saveDailyReport(
      {
        restaurantId: 'anamma',
        businessDate: '2026-09-14',
        ...REQUIRED,
        shifts: [{ shiftIndex: 0, total: '100,00' }],
      },
      { session: session() }
    );
    expect(result).toMatchObject({ ok: false, error: 'wrong_layout' });
  });

  it('refuses a ledger payload posted to CHINA SPICE', async () => {
    const { saveDailyReport } = await freshAction();
    const result = await saveDailyReport(
      {
        restaurantId: 'china_spice',
        businessDate: '2026-09-10',
        ...REQUIRED,
        ledger: { values: { gross: '100,00' }, counted: '100,00' },
      },
      { session: session() }
    );
    expect(result).toMatchObject({ ok: false, error: 'wrong_layout' });
  });

  it('refuses a row key that is not printed on that sheet', async () => {
    const { saveDailyReport } = await freshAction();
    const result = await saveDailyReport(
      {
        restaurantId: 'anamma',
        businessDate: '2026-09-14',
        ...REQUIRED,
        ledger: { values: { gross: '100,00', sneaked_in: '500,00' }, counted: '100,00' },
      },
      { session: session() }
    );
    expect(result).toMatchObject({ ok: false, error: 'unknown_row' });
  });

  it('refuses a payment method CHINA SPICE does not have', async () => {
    const { saveDailyReport } = await freshAction();
    const result = await saveDailyReport(
      {
        restaurantId: 'china_spice',
        businessDate: '2026-09-10',
        ...REQUIRED,
        shifts: [{ shiftIndex: 0, total: '100,00', methods: { REVOLUT: '10,00' } }],
      },
      { session: session() }
    );
    expect(result).toMatchObject({ ok: false, error: 'unknown_row' });
  });

  it('refuses to write a label into a row whose label is printed on the paper', async () => {
    const { saveDailyReport } = await freshAction();
    const result = await saveDailyReport(
      {
        restaurantId: 'anamma',
        businessDate: '2026-09-14',
        ...REQUIRED,
        ledger: { values: { gross: '100,00' }, labels: { gross: 'something else' }, counted: '100,00' },
      },
      { session: session() }
    );
    expect(result).toMatchObject({ ok: false, error: 'unknown_row' });
  });
});

// ── Approval and correction ──────────────────────────────────────────────

describe('approving', () => {
  const base = {
    restaurantId: 'anamma',
    businessDate: '2026-09-14',
    ...REQUIRED,
    status: 'approved' as const,
    ledger: { values: { gross: '2165,00' }, counted: '2165,00' },
  };

  it('writes the children BEFORE the report becomes approved', async () => {
    const { saveDailyReport, client } = await freshAction({ role: 'admin' });

    const result = await saveDailyReport(base, { session: session() });
    expect(result).toMatchObject({ ok: true, status: 'approved' });

    // The header goes in un-approved...
    expect(paramsOf(client, 'INSERT INTO zet_report\n')?.[2]).toBe('submitted');
    // ...children next, while the child guards are still a no-op...
    const lines = indexOf(client, 'INSERT INTO zet_report_line');
    const approve = indexOf(client, 'approved_at = now()');
    expect(lines).toBeGreaterThan(-1);
    expect(approve).toBeGreaterThan(lines);
    // ...and approving is a plain status change, not a correction: no
    // revision is bumped and no reason is demanded.
    expect(indexOf(client, 'revision_no = revision_no + 1')).toBe(-1);
  });

  it('lets an admin who filed the report approve it too', async () => {
    const { saveDailyReport, client } = await freshAction({ role: 'admin' });
    const result = await saveDailyReport(base, { session: session() });

    expect(result).toMatchObject({ ok: true, status: 'approved' });
    // created_by and approved_by are the same person here, but they are
    // recorded in separate columns so the archive can tell them apart if the
    // policy ever tightens.
    expect(paramsOf(client, 'INSERT INTO zet_report\n')?.[8]).toBe(USER);
    expect(paramsOf(client, 'approved_at = now()')?.[1]).toBe(USER);
  });

  it('promotes an existing draft without ever writing children into an approved report', async () => {
    const { saveDailyReport, client } = await freshAction({
      role: 'admin',
      existing: { id: REPORT, status: 'draft', revision_no: 1 },
    });

    expect(await saveDailyReport(base, { session: session() })).toMatchObject({ ok: true });
    expect(indexOf(client, 'INSERT INTO zet_report_line')).toBeLessThan(
      indexOf(client, 'approved_at = now()')
    );
  });

  // Approving is the admin's (05/10/2026), on this path as on the Approve
  // button. The form never posts status 'approved'; a hand-made request
  // does, and a restaurant login must not approve its own night with it.
  for (const role of ['staff', 'manager']) {
    it(`refuses a ${role} approving by saving, and writes nothing`, async () => {
      const { saveDailyReport, client } = await freshAction({ role });
      const result = await saveDailyReport(base, { session: session() });
      expect(result).toMatchObject({ ok: false, error: 'admin_required' });
      expect(indexOf(client, 'INSERT INTO zet_report')).toBe(-1);
      expect(indexOf(client, 'approved_at = now()')).toBe(-1);
    });
  }

  it('lets a manager submit, and keep editing, a night that is not approved', async () => {
    const { status: _approved, ...submit } = base;
    for (const existing of [null, { id: REPORT, status: 'submitted' as const, revision_no: 1 }]) {
      const { saveDailyReport } = await freshAction({ role: 'manager', existing });
      expect(await saveDailyReport(submit, { session: session() })).toMatchObject({
        ok: true,
        status: 'submitted',
      });
    }
  });
});

describe('correcting an approved report', () => {
  const base = {
    restaurantId: 'anamma',
    businessDate: '2026-09-14',
    ...REQUIRED,
    status: 'approved' as const,
    ledger: { values: { gross: '2200,00' }, counted: '2200,00' },
  };

  // An approved night is the admin's to correct (05/10/2026). Refused
  // before anything is written — not even the revision bump.
  for (const role of ['staff', 'manager']) {
    it(`refuses a ${role} changing an approved night, with or without a reason`, async () => {
      for (const status of ['approved', 'submitted'] as const) {
        const { saveDailyReport, client } = await freshAction({
          role,
          existing: { id: REPORT, status: 'approved', revision_no: 1 },
        });
        const result = await saveDailyReport(
          { ...base, status, correctionReason: 'recount' },
          { session: session() }
        );
        expect(result).toMatchObject({ ok: false, error: 'admin_required' });
        expect(indexOf(client, 'UPDATE zet_report SET')).toBe(-1);
      }
    });
  }

  it('refuses without a reason', async () => {
    const { saveDailyReport, client } = await freshAction({
      role: 'admin',
      existing: { id: REPORT, status: 'approved', revision_no: 1 },
    });

    const result = await saveDailyReport(base, { session: session() });

    expect(result).toMatchObject({ ok: false, error: 'correction_reason_required' });
    expect(indexOf(client, 'UPDATE zet_report SET')).toBe(-1);
  });

  it('bumps the revision on the header BEFORE touching a single child row', async () => {
    const { saveDailyReport, client } = await freshAction({
      role: 'admin',
      existing: { id: REPORT, status: 'approved', revision_no: 1 },
    });

    const result = await saveDailyReport(
      { ...base, correctionReason: 'Λάθος στο ΑΝΑΜΜΑ card1' },
      { session: session() }
    );

    expect(result).toMatchObject({ ok: true, revisionNo: 2 });

    const correction = indexOf(client, 'revision_no = revision_no + 1');
    const firstChildWrite = client.statements.findIndex(
      (s) => /zet_report_line|zet_report_slot|zet_expense_line|zet_cheque|zet_pending_receipt|zet_shift/.test(s.sql)
    );
    expect(correction).toBeGreaterThan(-1);
    expect(firstChildWrite).toBeGreaterThan(correction);

    // Migration 0003 rejects the correction unless all three arrive together.
    const sql = client.statements[correction]?.sql ?? '';
    expect(sql).toContain('correction_reason');
    expect(sql).toContain('correction_by');
    const params = client.statements[correction]?.params ?? [];
    expect(params[1]).toBe('Λάθος στο ΑΝΑΜΜΑ card1');
    expect(params[2]).toBe(USER);

    // A correction is one UPDATE, not a bump followed by a second approve.
    expect(indexOf(client, 'approved_at = now()')).toBe(-1);
  });

  it('never names variance_cents in any statement — the column is generated', async () => {
    const { saveDailyReport, client } = await freshAction({
      role: 'admin',
      existing: { id: REPORT, status: 'approved', revision_no: 1 },
    });
    await saveDailyReport({ ...base, correctionReason: 'διόρθωση' }, { session: session() });
    expect(client.statements.some((s) => s.sql.includes('variance_cents'))).toBe(false);
  });
});

describe('two managers closing the same day at once', () => {
  it('reports a conflict instead of throwing', async () => {
    vi.resetModules();
    const client = makeMockClient();
    const realQuery = client.query;
    client.query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO zet_report\n')) {
        throw Object.assign(new Error('duplicate key value'), { code: '23505' });
      }
      return realQuery(sql, params);
    }) as typeof client.query;
    mockConnect.mockResolvedValue(client);

    const { saveDailyReport } = await import('./saveReport');
    const result = await saveDailyReport(
      {
        restaurantId: 'anamma',
        businessDate: '2026-09-14',
        ...REQUIRED,
        ledger: { values: { gross: '2165,00' }, counted: '408,07' },
      },
      { session: session() }
    );

    expect(result).toMatchObject({ ok: false, error: 'conflict' });
  });
});

// ── The coupling the posted-total scan creates ───────────────────────────

describe('the form config stays compatible with the posted-total scan', () => {
  it('has no row or method key containing "cents"', async () => {
    // saveReport rejects any payload key matching /cents/i at any depth,
    // and the ledger `values` / shift `methods` maps are keyed by row and
    // method key. A form key containing "cents" would therefore make a
    // perfectly good sheet unsaveable, with an error blaming the client for
    // posting a total. Nothing on the four paper forms comes close, but the
    // coupling is invisible from forms.ts — so it fails here rather than at
    // 1am on a phone.
    const { FORMS, FORM_ORDER } = await import('../lib/forms');

    for (const id of FORM_ORDER) {
      const form = FORMS[id];
      const keys =
        form.layout === 'ledger'
          ? form.rows.map((r) => r.key)
          : form.methods.map((m) => m.key);
      for (const key of keys) {
        expect(`${id}.${key}`).not.toMatch(/cents/i);
      }
    }
  });
});

describe('rows the manager named by hand', () => {
  const NIGHT = {
    restaurantId: 'china_spice',
    businessDate: '2026-09-10',
    ...REQUIRED,
    shifts: [{ shiftIndex: 1, total: '100,00', methods: { CASH: '47,80' } }],
  };

  it('is stored under its own name, behind the reserved prefix', async () => {
    const { saveDailyReport, client } = await freshAction();
    const result = await saveDailyReport(
      { ...NIGHT, customLines: [{ label: 'ΝΙΜΑ', amounts: ['', '52,20', ''] }] },
      { session: session() }
    );

    expect(result.ok).toBe(true);
    const pay = paramsOf(client, 'INSERT INTO zet_shift_payment');
    expect(pay).not.toBeNull();
    const keys = pay![1] as string[];
    const amounts = pay![2] as number[];
    const at = keys.indexOf('X:ΝΙΜΑ');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(amounts[at]).toBe(5220);
  });

  // Non-cash, like every other row in that block of the printed sheet.
  it('lowers the cash the night expects', async () => {
    const { saveDailyReport } = await freshAction();
    const result = await saveDailyReport(
      { ...NIGHT, customLines: [{ label: 'ΝΙΜΑ', amounts: ['', '52,20', ''] }] },
      { session: session() }
    );
    expect(result).toMatchObject({ ok: true });
  });

  // The blank spare row is always on the sheet. Sending it must be
  // ordinary, not an error.
  it('ignores the untouched spare row', async () => {
    const { saveDailyReport, client } = await freshAction();
    const result = await saveDailyReport(
      { ...NIGHT, customLines: [{ label: '', amounts: ['', '', ''] }] },
      { session: session() }
    );
    expect(result.ok).toBe(true);
    const keys = paramsOf(client, 'INSERT INTO zet_shift_payment')![1] as string[];
    expect(keys.some((k) => k.startsWith('X:'))).toBe(false);
  });

  // The one thing a till sheet must never do is swallow a figure.
  it('refuses a figure with no name rather than dropping it', async () => {
    const { saveDailyReport } = await freshAction();
    const result = await saveDailyReport(
      { ...NIGHT, customLines: [{ label: '  ', amounts: ['', '52,20', ''] }] },
      { session: session() }
    );
    expect(result).toMatchObject({
      ok: false,
      error: 'invalid_payload',
      messages: ['Γράψτε όνομα στη γραμμή που έχει ποσό.'],
    });
  });

  it('refuses two rows with the same name, which would split one takings', async () => {
    const { saveDailyReport } = await freshAction();
    const result = await saveDailyReport(
      {
        ...NIGHT,
        customLines: [
          { label: 'ΝΙΜΑ', amounts: ['', '52,20', ''] },
          { label: 'νιμα', amounts: ['', '10,00', ''] },
        ],
      },
      { session: session() }
    );
    expect(result).toMatchObject({
      ok: false,
      error: 'invalid_payload',
      messages: ['Δύο γραμμές με το ίδιο όνομα — ενώστε τις.'],
    });
  });

  // China Spice is currently the ONLY shifts-layout sheet, so there is no
  // real restaurant that can exercise this branch — chop_pindarou is a
  // ledger and fails at wrong_layout long before reaching it. The guard
  // still has to work, because it fires the day a second shifts sheet is
  // added without the flag, so the form config is mocked to build that
  // restaurant rather than leaving the branch untested until then.
  it('refuses them on a shifts sheet whose config does not have them', async () => {
    vi.resetModules();
    const real = await vi.importActual<typeof import('../lib/forms')>('../lib/forms');
    const plain = { ...real.CHINA_SPICE, id: 'no_lines', allowCustomLines: undefined };
    vi.doMock('../lib/forms', () => ({
      ...real,
      FORMS: { ...real.FORMS, no_lines: plain },
      FORM_ORDER: [...real.FORM_ORDER, 'no_lines'],
    }));

    const client = makeMockClient();
    mockConnect.mockResolvedValue(client);
    const { saveDailyReport } = await import('./saveReport');

    const result = await saveDailyReport(
      {
        restaurantId: 'no_lines',
        businessDate: '2026-09-10',
        ...REQUIRED,
        shifts: [{ shiftIndex: 0, total: '100,00', methods: {} }],
        customLines: [{ label: 'ΝΙΜΑ', amounts: ['52,20'] }],
      },
      { session: session() }
    );

    vi.doUnmock('../lib/forms');
    expect(result).toMatchObject({ ok: false, error: 'unknown_row' });
  });

  // The guard that keeps a stale draft from inventing a payment method
  // must not have been loosened to let named rows through.
  it('still refuses a prefixed key smuggled in through methods', async () => {
    const { saveDailyReport } = await freshAction();
    const result = await saveDailyReport(
      {
        ...NIGHT,
        shifts: [{ shiftIndex: 1, total: '100,00', methods: { 'X:ΝΙΜΑ': '52,20' } }],
      },
      { session: session() }
    );
    expect(result).toMatchObject({ ok: false, error: 'unknown_row' });
  });
});

// ── Card brackets ─────────────────────────────────────────────────────────

describe('card brackets', () => {
  const ledgerNight = (values: Record<string, string>) => ({
    restaurantId: 'anamma',
    businessDate: '2026-10-08',
    ...REQUIRED,
    ledger: { values: { gross: '1000,00', ...values }, counted: '600,00' },
  });

  it('saves each bracket and deducts their sum', async () => {
    const { saveDailyReport, client } = await freshAction();
    const result = await saveDailyReport(ledgerNight({ CARD_1: '250,00', CARD_2: '150,00' }), { session: session() });

    expect(result).toMatchObject({ ok: true, expectedCents: 60000, varianceCents: 0 });
    const lines = paramsOf(client, 'INSERT INTO zet_report_line');
    const keys = lines?.[1] as string[];
    const amounts = lines?.[3] as number[];
    expect(amounts[keys.indexOf('CARD_1')]).toBe(25000);
    expect(amounts[keys.indexOf('CARD_2')]).toBe(15000);
    // The total is derived, never stored.
    expect(keys).not.toContain('CARD_BRACKETS');
  });

  it('a bracket left blank still deducts nothing and saves', async () => {
    const { saveDailyReport } = await freshAction();
    const result = await saveDailyReport(ledgerNight({ CARD_1: '', CARD_2: '400,00' }), { session: session() });
    expect(result).toMatchObject({ ok: true, expectedCents: 60000 });
  });

  it('refuses a bracket past the ceiling, and the group total as a figure', async () => {
    for (const values of [{ CARD_13: '400,00' }, { CARD_0: '400,00' }, { CARD_BRACKETS: '400,00' }] as Array<Record<string, string>>) {
      const { saveDailyReport } = await freshAction();
      const result = await saveDailyReport(ledgerNight(values), { session: session() });
      expect(result).toMatchObject({ ok: false, error: 'unknown_row' });
    }
  });

  it('a night without brackets saves exactly as before', async () => {
    const { saveDailyReport, client } = await freshAction();
    const result = await saveDailyReport(ledgerNight({ card2: '400,00' }), { session: session() });
    expect(result).toMatchObject({ ok: true, expectedCents: 60000 });
    const keys = paramsOf(client, 'INSERT INTO zet_report_line')?.[1] as string[];
    expect(keys.some((k) => k.startsWith('CARD_'))).toBe(false);
  });

  it('Montparnasse: brackets in any shift count as card money for that shift', async () => {
    const { saveDailyReport } = await freshAction();
    const result = await saveDailyReport(
      {
        restaurantId: 'china_spice',
        businessDate: '2026-10-08',
        ...REQUIRED,
        shifts: [
          { shiftIndex: 0, dineIn: '', ta: '', total: '500,00', methods: { CASH: '200,00', CARD_1: '200,00', CARD_2: '100,00' } },
          { shiftIndex: 1, dineIn: '', ta: '', total: '300,00', methods: { CASH: '100,00', CARD_1: '200,00', CARD_2: '' } },
        ],
      },
      { session: session() }
    );
    expect(result).toMatchObject({ ok: true, expectedCents: 30000, varianceCents: 0 });
  });
});
