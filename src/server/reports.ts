/**
 * Reading saved reports back: the archive and the flagged list.
 *
 * Every query runs inside withUserTransaction, so row-level security scopes
 * it to the restaurants this user belongs to. There is no "all reports"
 * query in this file on purpose — a caller cannot accidentally get one
 * restaurant's takings while looking at another's.
 *
 * ── Flags are computed on read, not stored ──────────────────────────────
 *
 * A stored flag column would be a second source of truth: correct a report
 * and the flag is stale until something recomputes it. Computing on read is
 * always consistent with the figures actually in the database, and at four
 * restaurants filing one sheet a night — around 1,500 rows a year — the
 * cost is nothing. If that ever stops being true, this is the file to
 * change, and the rule itself lives in src/lib/flags.ts either way.
 *
 * ── bigint comes back as a STRING ───────────────────────────────────────
 *
 * node-postgres returns int8 as a string, because a bigint can exceed what
 * a JavaScript number holds exactly. Every *_cents column is bigint, so a
 * raw row gives '40807', not 40807 — and '40807' + 0 is '408070'. This is
 * the first code in the project to SELECT those columns back (saveReport
 * computes its totals in JS and never reads them), so it is the first place
 * that could get it wrong. centsFromDb below converts once, at the edge,
 * and refuses anything that would lose precision.
 */

import type { PoolClient } from 'pg';
import { withUserTransaction } from '../lib/db';
import { flagsFor, type Flag } from '../lib/flags';
import { FORMS, rowLabelFor, type FormId } from '../lib/forms';
import { isCustomLineKey, labelFromCustomKey } from '../lib/customLine';
import {
  itemsForEdit,
  itemsFromDb,
  type ReceiptItem,
  type ReceiptItemInput,
} from '../lib/receiptItems';

/**
 * A `date` column is a calendar day, not an instant. node-postgres hands it
 * back as a Date at local midnight, and toISOString() then converts that to
 * UTC — which in Cyprus (UTC+2/+3) lands on the PREVIOUS day. A sheet filed
 * on the 14th would be listed as the 13th.
 *
 * So: read the local calendar fields, never an ISO conversion. This bug was
 * in the restaurant summary until the printed output was read rather than
 * just the assertions.
 */
function businessDateString(value: unknown): string {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value);
}

function centsFromDb(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`amount ${String(value)} is not a safe integer — refusing to read it as cents`);
  }
  return n;
}

export interface ReportSummary {
  id: string;
  restaurantId: string;
  businessDate: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
  revisionNo: number;
  expectedCents: number;
  actualCents: number;
  varianceCents: number;
  closingManagerName: string | null;
  flags: Flag[];
}

export interface RestaurantSummary {
  restaurantId: string;
  displayName: string;
  reportCount: number;
  flaggedCount: number;
  latestBusinessDate: string | null;
}

/**
 * The widest slot-vs-total disagreement on each report.
 *
 * `HAVING sum(...) > 0` matters: the paper lets someone write only a
 * platform's ΟΛΙΚΟ and leave α)…ε) blank, and that is not an error. Only
 * rows whose slots were actually filled in get compared.
 */
const SLOT_DIFF_CTE = `
  slot_diff AS (
    SELECT l.report_id,
           max(abs(l.amount_cents - st.total)) AS max_diff
      FROM zet_report_line l
      JOIN (
        SELECT report_line_id, sum(amount_cents) AS total
          FROM zet_report_slot
         GROUP BY report_line_id
        HAVING sum(amount_cents) > 0
      ) st ON st.report_line_id = l.id
     GROUP BY l.report_id
  )
`;

function toSummary(row: Record<string, unknown>): ReportSummary {
  const varianceCents = centsFromDb(row.variance_cents);
  const slotMaxDiff = centsFromDb(row.slot_max_diff);

  return {
    id: String(row.id),
    restaurantId: String(row.restaurant_id),
    // node-postgres hands back a Date for `date`; take the calendar day as
    // stored, never a UTC conversion of it — the trading day is not a
    // timestamp and must not shift near midnight.
    businessDate: businessDateString(row.business_date),
    status: row.status as ReportSummary['status'],
    revisionNo: Number(row.revision_no),
    expectedCents: centsFromDb(row.expected_cents),
    actualCents: centsFromDb(row.actual_cents),
    varianceCents,
    closingManagerName: (row.closing_manager_name as string | null) ?? null,
    flags: flagsFor({
      varianceCents,
      slotRows:
        slotMaxDiff > 0
          ? [{ rowKey: '', rowCents: slotMaxDiff, slotTotalCents: 0 }]
          : [],
    }),
  };
}

/** One row per restaurant this user belongs to, for the archive's front page. */
export async function listRestaurantSummaries(userId: string): Promise<RestaurantSummary[]> {
  return withUserTransaction(userId, async (client: PoolClient) => {
    const { rows } = await client.query(
      `WITH ${SLOT_DIFF_CTE}
       SELECT res.id   AS restaurant_id,
              res.display_name,
              count(r.id)                             AS report_count,
              max(r.business_date)                    AS latest_business_date,
              count(*) FILTER (
                WHERE abs(r.variance_cents) >= $1
                   OR COALESCE(sd.max_diff, 0) >= $1
              )                                       AS flagged_count
         FROM restaurant res
         LEFT JOIN zet_report r ON r.restaurant_id = res.id
         LEFT JOIN slot_diff sd ON sd.report_id = r.id
        WHERE res.active
          -- restaurant has no RLS of its own; restaurant_user does. Without
          -- this, a restaurant login's archive listed every restaurant (as
          -- empty), naming businesses it has nothing to do with.
          AND res.id IN (SELECT restaurant_id FROM restaurant_user)
        GROUP BY res.id, res.display_name
        ORDER BY res.display_name`,
      [50]
    );

    return rows.map((row) => ({
      restaurantId: String(row.restaurant_id),
      displayName: String(row.display_name),
      reportCount: Number(row.report_count),
      flaggedCount: Number(row.flagged_count),
      latestBusinessDate:
        row.latest_business_date === null ? null : businessDateString(row.latest_business_date),
    }));
  });
}

/** One restaurant's nights, newest first. */
export async function listReports(
  userId: string,
  restaurantId: FormId | string,
  options: { onlyFlagged?: boolean; limit?: number } = {}
): Promise<ReportSummary[]> {
  const limit = Math.min(options.limit ?? 200, 500);

  return withUserTransaction(userId, async (client: PoolClient) => {
    const { rows } = await client.query(
      `WITH ${SLOT_DIFF_CTE}
       SELECT r.id, r.restaurant_id, r.business_date, r.status, r.revision_no,
              r.expected_cents, r.actual_cents, r.variance_cents,
              r.closing_manager_name,
              COALESCE(sd.max_diff, 0) AS slot_max_diff
         FROM zet_report r
         LEFT JOIN slot_diff sd ON sd.report_id = r.id
        WHERE r.restaurant_id = $1
          AND ($2::boolean IS NOT TRUE
               OR abs(r.variance_cents) >= $3
               OR COALESCE(sd.max_diff, 0) >= $3)
        ORDER BY r.business_date DESC
        LIMIT $4`,
      [restaurantId, options.onlyFlagged ?? false, 50, limit]
    );

    return rows.map(toSummary);
  });
}

/**
 * Every flagged night across every restaurant this user may see.
 * RLS still scopes it — "every restaurant" means every one they belong to.
 */
export async function listFlagged(userId: string): Promise<ReportSummary[]> {
  return withUserTransaction(userId, async (client: PoolClient) => {
    const { rows } = await client.query(
      `WITH ${SLOT_DIFF_CTE}
       SELECT r.id, r.restaurant_id, r.business_date, r.status, r.revision_no,
              r.expected_cents, r.actual_cents, r.variance_cents,
              r.closing_manager_name,
              COALESCE(sd.max_diff, 0) AS slot_max_diff
         FROM zet_report r
         LEFT JOIN slot_diff sd ON sd.report_id = r.id
        WHERE abs(r.variance_cents) >= $1
           OR COALESCE(sd.max_diff, 0) >= $1
        ORDER BY r.business_date DESC, r.restaurant_id`,
      [50]
    );
    return rows.map(toSummary);
  });
}

export interface ReportLine {
  rowKey: string;
  labelOverride: string | null;
  amountCents: number;
  slotTotalCents: number;
  slotCount: number;
}

export interface ReportDetail extends ReportSummary {
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  lines: ReportLine[];
  expenses: Array<{
    lineNo: number;
    description: string | null;
    amountCents: number;
    supplierName: string;
    invoiceNumber: string;
    invoiceDate: string;
    /** What the receipt lists (migration 0007). Empty for most lines. */
    items: ReceiptItem[];
  }>;
  revisionCount: number;
}

/**
 * One night, in full. Returns null when the report does not exist OR when
 * row-level security hides it — the caller cannot tell those apart, which
 * is the point: "no such report" and "not yours" must look identical, or
 * the difference tells an outsider which nights exist.
 */
export async function getReportDetail(
  userId: string,
  restaurantId: FormId | string,
  businessDate: string
): Promise<ReportDetail | null> {
  return withUserTransaction(userId, async (client: PoolClient) => {
    const { rows } = await client.query(
      `WITH ${SLOT_DIFF_CTE}
       SELECT r.id, r.restaurant_id, r.business_date, r.status, r.revision_no,
              r.expected_cents, r.actual_cents, r.variance_cents,
              r.closing_manager_name, r.created_by, r.approved_by, r.approved_at,
              COALESCE(sd.max_diff, 0) AS slot_max_diff,
              (SELECT count(*) FROM zet_report_revision v WHERE v.report_id = r.id)
                AS revision_count
         FROM zet_report r
         LEFT JOIN slot_diff sd ON sd.report_id = r.id
        WHERE r.restaurant_id = $1 AND r.business_date = $2::date`,
      [restaurantId, businessDate]
    );

    const row = rows[0];
    if (!row) return null;

    const { rows: lineRows } = await client.query(
      `SELECT l.row_key, l.label_override, l.amount_cents,
              COALESCE(s.total, 0) AS slot_total,
              COALESCE(s.n, 0)     AS slot_count
         FROM zet_report_line l
         LEFT JOIN (
           SELECT report_line_id, sum(amount_cents) AS total, count(*) AS n
             FROM zet_report_slot GROUP BY report_line_id
         ) s ON s.report_line_id = l.id
        WHERE l.report_id = $1
        ORDER BY l.row_key`,
      [row.id]
    );

    const { rows: expenseRows } = await client.query(
      `SELECT line_no, description, amount_cents,
              supplier_name, invoice_number, invoice_date, receipt_items
         FROM zet_expense_line WHERE report_id = $1 ORDER BY line_no`,
      [row.id]
    );

    const lines: ReportLine[] = lineRows.map((l) => ({
      rowKey: String(l.row_key),
      labelOverride: (l.label_override as string | null) ?? null,
      amountCents: centsFromDb(l.amount_cents),
      slotTotalCents: centsFromDb(l.slot_total),
      slotCount: Number(l.slot_count),
    }));

    const varianceCents = centsFromDb(row.variance_cents);

    return {
      ...toSummary(row),
      // Recomputed from the real rows, so each flag names its own row
      // rather than reporting only the widest difference the list needed.
      flags: flagsFor({
        varianceCents,
        slotRows: lines
          .filter((l) => l.slotCount > 0 && l.slotTotalCents > 0)
          .map((l) => ({
            rowKey: l.rowKey,
            // Named the way every other surface names it, rather than
            // the raw database key — a flag that says "card1" tells the
            // person reading it less than the sheet already does.
            rowLabel: FORMS[restaurantId as FormId]
              ? rowLabelFor(FORMS[restaurantId as FormId], l.rowKey, l.labelOverride)
              : (l.labelOverride ?? undefined),
            rowCents: l.amountCents,
            slotTotalCents: l.slotTotalCents,
          })),
      }),
      createdBy: (row.created_by as string | null) ?? null,
      approvedBy: (row.approved_by as string | null) ?? null,
      approvedAt:
        row.approved_at instanceof Date ? row.approved_at.toISOString() : (row.approved_at as string | null),
      lines,
      expenses: expenseRows.map((e) => ({
        lineNo: Number(e.line_no),
        description: (e.description as string | null) ?? null,
        amountCents: centsFromDb(e.amount_cents),
        supplierName: String(e.supplier_name ?? ''),
        invoiceNumber: String(e.invoice_number ?? ''),
        invoiceDate: e.invoice_date ? businessDateString(e.invoice_date) : '',
        items: itemsFromDb(e.receipt_items),
      })),
      revisionCount: Number(row.revision_count),
    };
  });
}

export interface RevisionEntry {
  revisionNo: number;
  reason: string;
  changedAt: string;
  statusAtRevision: string;
  /** The figures as they stood BEFORE this correction. */
  expectedCents: number;
  actualCents: number;
}

/**
 * The history of corrections to one night, oldest first.
 *
 * Each row holds the report as it was BEFORE that correction — the trigger
 * archives the old state on the way past, not the new one. So revision 1 is
 * what the first approved version said, and the live row is what it says
 * now. Verified against a live database: after correcting card1 from 400,00
 * to 350,00, the snapshot still reads 400,00.
 *
 * The snapshot is jsonb of the whole report and every child row. Only the
 * headline figures are pulled out here; the full document is there for an
 * accountant who ever needs it.
 */
export async function listRevisions(
  userId: string,
  restaurantId: FormId | string,
  businessDate: string
): Promise<RevisionEntry[]> {
  return withUserTransaction(userId, async (client: PoolClient) => {
    const { rows } = await client.query(
      `SELECT v.revision_no, v.reason, v.changed_at, v.status_at_revision,
              (v.snapshot->'report'->>'expected_cents') AS expected_cents,
              (v.snapshot->'report'->>'actual_cents')   AS actual_cents
         FROM zet_report_revision v
         JOIN zet_report r ON r.id = v.report_id
        WHERE r.restaurant_id = $1 AND r.business_date = $2::date
        ORDER BY v.revision_no`,
      [restaurantId, businessDate]
    );

    return rows.map((r) => ({
      revisionNo: Number(r.revision_no),
      reason: String(r.reason ?? ''),
      changedAt: r.changed_at instanceof Date ? r.changed_at.toISOString() : String(r.changed_at),
      statusAtRevision: String(r.status_at_revision),
      expectedCents: centsFromDb(r.expected_cents),
      actualCents: centsFromDb(r.actual_cents),
    }));
  });
}

/**
 * A saved night, shaped exactly like the ledger form's own fields, so a
 * correction starts from what was filed rather than from a blank sheet.
 *
 * Retyping fifteen figures to change one is how a second error gets
 * introduced, which on a correction is worse than the first — the first was
 * a mistake, the second happens while trying to fix it.
 *
 * Amounts come back as STRINGS in the Greek convention the form uses, not
 * as cents. The form owns exactly one parser (src/lib/money.ts) and the
 * whole project's rule is that the server never receives a parsed figure;
 * handing the form cents would quietly create a second path.
 *
 * Returns null for a night that does not exist or is not this user's, and
 * for a shifts sheet — correcting those is not built yet, and silently
 * rendering a ledger form against shift data would be worse than refusing.
 */
export async function getReportForEdit(
  userId: string,
  restaurantId: FormId | string,
  businessDate: string,
  formatAmount: (cents: number) => string
): Promise<{
  businessDate: string;
  closingManagerName: string;
  signature: string;
  values: Record<string, string>;
  labels: Record<string, string>;
  slots: Record<string, string[]>;
  /** Named lines, which are not printed rows and so are not in `values`. */
  customLines: Array<{ label: string; amount: string }>;
  expenses: Array<{
    description: string;
    amount: string;
    supplier: string;
    invoiceNumber: string;
    invoiceDate: string;
    items: ReceiptItemInput[];
  }>;
  cheques: Array<{
    amount: string; customerName: string; customerPhone: string;
    chequeNumber: string; bank: string;
  }>;
  pendingReceipts: Array<{
    amount: string; organisationName: string; contactPerson: string;
    contactPhone: string; receiptNumber: string;
  }>;
  counted: string;
} | null> {
  return withUserTransaction(userId, async (client: PoolClient) => {
    const { rows } = await client.query(
      `SELECT r.id, r.business_date, r.closing_manager_name, r.actual_cents
         FROM zet_report r
         JOIN restaurant res ON res.id = r.restaurant_id
        WHERE r.restaurant_id = $1 AND r.business_date = $2::date
          AND res.layout = 'ledger'`,
      [restaurantId, businessDate]
    );
    const head = rows[0];
    if (!head) return null;

    // SEQUENTIAL, not Promise.all. A single pg client runs one query at a
    // time; firing five at once on the same client does not error — it
    // quietly returns undefined for the later ones, which here meant a
    // correction form silently missing its expenses and itemised orders.
    // Only caught by running it and reading the output.
    const lineRes = await client.query(
      `SELECT id, row_key, label_override, amount_cents
         FROM zet_report_line WHERE report_id = $1`, [head.id]);
    const slotRes = await client.query(
      `SELECT s.report_line_id, s.slot_index, s.amount_cents
         FROM zet_report_slot s
         JOIN zet_report_line l ON l.id = s.report_line_id
        WHERE l.report_id = $1 ORDER BY s.slot_index`, [head.id]);
    const expRes = await client.query(
      `SELECT description, amount_cents, supplier_name, invoice_number, invoice_date,
              receipt_items
         FROM zet_expense_line WHERE report_id = $1 ORDER BY line_no`, [head.id]);
    const chqRes = await client.query(
      `SELECT amount_cents, customer_name, customer_phone, cheque_number, bank
         FROM zet_cheque WHERE report_id = $1 ORDER BY id`, [head.id]);
    const pendRes = await client.query(
      `SELECT amount_cents, organisation_name, contact_person, contact_phone, receipt_number
         FROM zet_pending_receipt WHERE report_id = $1 ORDER BY id`, [head.id]);

    const values: Record<string, string> = {};
    const labels: Record<string, string> = {};
    const lineKeyById = new Map<string, string>();

    const customLines: Array<{ label: string; amount: string }> = [];

    for (const l of lineRes.rows) {
      const key = String(l.row_key);
      lineKeyById.set(String(l.id), key);
      const cents = centsFromDb(l.amount_cents);

      // A named line is not a printed row: it belongs in its own list,
      // not in `values`, which is keyed off the form config. Leaving it
      // out of the list would hand back a sheet missing the line — and
      // the next save would then write the night without it.
      if (isCustomLineKey(key)) {
        customLines.push({
          label: String(l.label_override ?? '') || labelFromCustomKey(key),
          amount: cents === 0 ? '' : formatAmount(cents),
        });
        continue;
      }

      // A zero comes back as an EMPTY field, not "0,00". The paper leaves
      // unused rows blank, and pre-filling zeros would make every untouched
      // row look deliberately entered.
      if (cents !== 0) values[key] = formatAmount(cents);
      if (l.label_override) labels[key] = String(l.label_override);
    }

    const slots: Record<string, string[]> = {};
    for (const s of slotRes.rows) {
      const key = lineKeyById.get(String(s.report_line_id));
      if (!key) continue;
      const list = (slots[key] ??= []);
      const cents = centsFromDb(s.amount_cents);
      list[Number(s.slot_index)] = cents === 0 ? '' : formatAmount(cents);
    }
    for (const key of Object.keys(slots)) {
      slots[key] = Array.from(slots[key]!, (v) => v ?? '');
    }

    return {
      businessDate: businessDateString(head.business_date),
      closingManagerName: String(head.closing_manager_name ?? ''),
      // Deliberately blank. A signature is someone signing THIS version;
      // carrying the old one forward would sign the correction in the
      // original person's name.
      signature: '',
      values,
      labels,
      slots,
      customLines,
      expenses: expRes.rows.map((e) => ({
        description: String(e.description ?? ''),
        amount: centsFromDb(e.amount_cents) === 0 ? '' : formatAmount(centsFromDb(e.amount_cents)),
        // Read back so a CORRECTION reloads them. Leaving these out would
        // mean every correction quietly cleared the supplier, invoice
        // number and date of every receipt on the night — a save that
        // destroys data it never showed anyone.
        supplier: String(e.supplier_name ?? ''),
        invoiceNumber: String(e.invoice_number ?? ''),
        invoiceDate: e.invoice_date ? businessDateString(e.invoice_date) : '',
        // Read back for the same reason as the three above: the save path
        // deletes and re-inserts every expense line, so a correction that
        // did not reload the items would erase them from every receipt.
        items: itemsForEdit(itemsFromDb(e.receipt_items), formatAmount),
      })),
      cheques: chqRes.rows.map((c) => ({
        amount: formatAmount(centsFromDb(c.amount_cents)),
        customerName: String(c.customer_name ?? ''),
        customerPhone: String(c.customer_phone ?? ''),
        chequeNumber: String(c.cheque_number ?? ''),
        bank: String(c.bank ?? ''),
      })),
      pendingReceipts: pendRes.rows.map((p) => ({
        amount: formatAmount(centsFromDb(p.amount_cents)),
        organisationName: String(p.organisation_name ?? ''),
        contactPerson: String(p.contact_person ?? ''),
        contactPhone: String(p.contact_phone ?? ''),
        receiptNumber: String(p.receipt_number ?? ''),
      })),
      counted: formatAmount(centsFromDb(head.actual_cents)),
    };
  });
}

export interface ShiftDetail {
  shiftIndex: number;
  label: string;
  dineInCents: number;
  /** Words, when the box held words rather than a figure. */
  dineInNote: string;
  taNote: string;
  taCents: number;
  totalCents: number;
  payments: Array<{ methodKey: string; amountCents: number }>;

}

/**
 * The shift columns of a CHINA SPICE night.
 *
 * Kept separate from getReportDetail rather than folded into it: a ledger
 * night has no shifts and a shifts night has no lines, so one function
 * returning both would hand every caller two fields of which one is always
 * empty, and invite rendering the wrong one.
 *
 * Sequential queries, not Promise.all — a pg client runs one query at a
 * time and silently returns undefined for the rest.
 */
/** A night's shifts and its single invoice list — see migration 0005. */
export interface ShiftsDetail {
  shifts: ShiftDetail[];
  invoices: Array<{
    lineNo: number;
    supplierName: string;
    invoiceNumber: string;
    amountCents: number;
    invoiceDate: string;
    /** What the receipt lists (migration 0007). Empty for most lines. */
    items: ReceiptItem[];
  }>;
  invoiceCents: number;
}

export async function listShifts(
  userId: string,
  restaurantId: FormId | string,
  businessDate: string
): Promise<ShiftsDetail> {
  return withUserTransaction(userId, async (client: PoolClient) => {
    const { rows: shiftRows } = await client.query(
      `SELECT s.id, s.shift_index, s.label, s.dine_in_cents, s.ta_cents, s.total_cents,
              s.dine_in_note, s.ta_note
         FROM zet_shift s
         JOIN zet_report r ON r.id = s.report_id
        WHERE r.restaurant_id = $1 AND r.business_date = $2::date
        ORDER BY s.shift_index`,
      [restaurantId, businessDate]
    );
    if (shiftRows.length === 0) return { shifts: [], invoices: [], invoiceCents: 0 };

    const ids = shiftRows.map((s) => s.id);

    const { rows: payRows } = await client.query(
      `SELECT shift_id, method_key, amount_cents
         FROM zet_shift_payment WHERE shift_id = ANY($1::uuid[])
        ORDER BY method_key`,
      [ids]
    );
    // Keyed on the REPORT, not the shifts — one list for the night.
    const { rows: invRows } = await client.query(
      `SELECT ri.line_no, ri.supplier_name, ri.invoice_number, ri.amount_cents,
              ri.invoice_date, ri.receipt_items
         FROM zet_report_invoice ri
         JOIN zet_report r ON r.id = ri.report_id
        WHERE r.restaurant_id = $1 AND r.business_date = $2::date
        ORDER BY ri.line_no`,
      [restaurantId, businessDate]
    );

    const invoices = invRows.map((i) => ({
      lineNo: Number(i.line_no),
      supplierName: String(i.supplier_name ?? ''),
      invoiceNumber: String(i.invoice_number ?? ''),
      amountCents: centsFromDb(i.amount_cents),
      // businessDateString, not toISOString: a `date` arrives as a Date at
      // LOCAL midnight, which in Cyprus shifts back a day.
      invoiceDate: i.invoice_date ? businessDateString(i.invoice_date) : '',
      items: itemsFromDb(i.receipt_items),
    }));

    const shifts = shiftRows.map((s) => ({
      shiftIndex: Number(s.shift_index),
      label: String(s.label),
      dineInCents: centsFromDb(s.dine_in_cents),
      dineInNote: String(s.dine_in_note ?? ''),
      taCents: centsFromDb(s.ta_cents),
      taNote: String(s.ta_note ?? ''),
      totalCents: centsFromDb(s.total_cents),
      payments: payRows
        .filter((p) => String(p.shift_id) === String(s.id))
        .map((p) => ({ methodKey: String(p.method_key), amountCents: centsFromDb(p.amount_cents) })),
    }));

    return {
      shifts,
      invoices,
      invoiceCents: invoices.reduce((a, i) => a + i.amountCents, 0),
    };
  });
}

/**
 * A saved shifts night, shaped exactly like the shifts form's own fields.
 * The ledger equivalent is getReportForEdit; same reasoning, same rules:
 * amounts as Greek-formatted STRINGS so the form's single parser stays the
 * only one, zeros left blank, signature deliberately dropped.
 *
 * Returns null for a ledger night, so a shifts form is never rendered
 * against ledger data.
 */
export async function getShiftsReportForEdit(
  userId: string,
  restaurantId: FormId | string,
  businessDate: string,
  formatAmount: (cents: number) => string,
  methodKeys: readonly string[]
): Promise<{
  businessDate: string;
  closingManagerName: string;
  signature: string;
  shifts: Array<{
    dineIn: string;
    ta: string;
    total: string;
    methods: Record<string, string>;
  }>;
  /** The night's invoices — one list, not one per shift (migration 0005). */
  invoices: Array<{
    supplier: string;
    invoiceNumber: string;
    amount: string;
    invoiceDate: string;
    items: ReceiptItemInput[];
  }>;
  /**
   * Rows the manager named by hand. These MUST be returned: the loop
   * below rebuilds methods from the form config, which by definition
   * does not know these keys, and the save path deletes every payment
   * for the shift before re-inserting. Leaving them out would mean a
   * correction to any other figure silently erased them.
   */
  customLines: Array<{ label: string; amounts: string[] }>;
} | null> {
  const blank = (cents: number) => (cents === 0 ? '' : formatAmount(cents));

  return withUserTransaction(userId, async (client: PoolClient) => {
    const { rows } = await client.query(
      `SELECT r.business_date, r.closing_manager_name
         FROM zet_report r
         JOIN restaurant res ON res.id = r.restaurant_id
        WHERE r.restaurant_id = $1 AND r.business_date = $2::date
          AND res.layout = 'shifts'`,
      [restaurantId, businessDate]
    );
    const head = rows[0];
    if (!head) return null;

    const night = await listShifts(userId, restaurantId, businessDate);

    // Always three columns, whatever was stored. A night where only the
    // evening was filled in still has three on the paper, and a correction
    // must be able to add the one that was missed.
    const byIndex = new Map(night.shifts.map((s) => [s.shiftIndex, s]));

    // First appearance wins the ordering, and listShifts already sorts
    // payments by method_key, so the same night always comes back in the
    // same order rather than shuffling between corrections.
    const customKeys: string[] = [];
    for (const i of [0, 1, 2]) {
      for (const pay of byIndex.get(i)?.payments ?? []) {
        if (isCustomLineKey(pay.methodKey) && !customKeys.includes(pay.methodKey)) {
          customKeys.push(pay.methodKey);
        }
      }
    }

    return {
      businessDate: businessDateString(head.business_date),
      closingManagerName: String(head.closing_manager_name ?? ''),
      signature: '',
      customLines: customKeys.map((key) => ({
        label: labelFromCustomKey(key),
        amounts: [0, 1, 2].map((i) =>
          blank(byIndex.get(i)?.payments.find((pay) => pay.methodKey === key)?.amountCents ?? 0)
        ),
      })),
      invoices: night.invoices.map((inv) => ({
        supplier: inv.supplierName,
        invoiceNumber: inv.invoiceNumber,
        amount: blank(inv.amountCents),
        invoiceDate: inv.invoiceDate,
        // Reloaded so a correction does not erase them — the save path
        // rewrites the whole invoice list.
        items: itemsForEdit(inv.items, formatAmount),
      })),
      shifts: [0, 1, 2].map((i) => {
        const s = byIndex.get(i);
        const methods: Record<string, string> = {};
        for (const key of methodKeys) {
          const found = s?.payments.find((p) => p.methodKey === key);
          methods[key] = blank(found?.amountCents ?? 0);
        }
        return {
          // The note wins when there is one: cents is 0 beside it, and
          // rendering that 0 as '' would hand the manager an empty box
          // and erase what they wrote on the next save.
          dineIn: s?.dineInNote ? s.dineInNote : blank(s?.dineInCents ?? 0),
          ta: s?.taNote ? s.taNote : blank(s?.taCents ?? 0),
          total: blank(s?.totalCents ?? 0),
          methods,

        };
      }),
    };
  });
}
