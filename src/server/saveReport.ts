/**
 * Saving a daily report — the one write path for a closed till.
 *
 * This is the server action from docs/PROMPTS.md step 3. It is written as a
 * plain async function rather than a file carrying Next's 'use server'
 * directive: that directive requires every export in the module to be an
 * async function, and this module also exports the types the form needs.
 * The Next wiring is a three-line wrapper file (src/app/actions.ts) that
 * marks itself 'use server', reads the session, and calls saveDailyReport.
 * Keeping the logic here is also what makes it unit testable without a
 * running framework.
 *
 * The Greek message constants (MSG_DATE etc.) live in src/lib/messages.ts,
 * not here, and are only re-exported below for continuity — this module
 * pulls in src/lib/db.ts, which opens a real `pg` connection pool at module
 * load, so nothing that imports THIS file's runtime code can ever be safe
 * in a browser bundle. A "use client" component that wants the same Greek
 * text for a live, pre-save checklist imports src/lib/messages.ts directly.
 *
 * The rules it exists to enforce, and where each one lives:
 *
 * 1. NO CLIENT TOTALS (CLAUDE.md rule 2). Two layers. First, any key
 *    containing "cents", anywhere in the payload at any depth, is a hard
 *    rejection — not ignored. Second, every amount arrives as the STRING
 *    the manager typed and is parsed here by src/lib/money.ts. There is no
 *    numeric-amount path into this function at all, so there is nothing for
 *    a client to pre-compute. Totals come only from src/lib/compute.ts.
 *
 * 2. AUTHORISE ON EVERY REQUEST (rule 3), in the same transaction as the
 *    write. getRestaurantRole is called with the client already opened by
 *    withUserTransaction, never the standalone overload — that one acquires
 *    a second pool connection per request, and enough concurrent requests
 *    each holding one connection while waiting for a second deadlocks the
 *    pool.
 *
 * 3. ZOD AT THE BOUNDARY (rule 4), with SPEC.md §5's rules — which are
 *    deliberately almost none. Required: business date, closing manager,
 *    signature. Not enforced: slots matching their row, itemised lines
 *    matching their row, Dine in + T/A matching Total, negative expected
 *    cash, date ranges, any difference threshold. Those are shown, not
 *    blocked. Where docs/zet-daily-report-schema.md §5 disagrees, SPEC.md
 *    wins: there are no amount ceilings here.
 *
 * 4. IDENTIFY BY WHAT IT IS (rule 6). Which layout a payload must use comes
 *    from the restaurant's config in src/lib/forms.ts, never from which
 *    block the client happened to send. Row keys, method keys and shift
 *    labels are all checked against — or taken from — that config.
 *
 * 5. CORRECTIONS GO THROUGH THE DB PROTOCOL. Correcting an approved report
 *    updates zet_report with revision_no bumped and correction_reason /
 *    correction_by set BEFORE any child row is touched, in one transaction.
 *    That single UPDATE is what fires the archive trigger and arms the
 *    txid-keyed lock from 0003; a child write before it is rejected with
 *    SQLSTATE ZET01. See applyCorrection below.
 */

import { z } from 'zod';
import type { PoolClient } from 'pg';
import { withUserTransaction, getRestaurantRole } from '../lib/db';
import { authorizeRestaurantAccess, type AuthzDecision, type Session } from '../lib/authorize';
import {
  FORMS,
  FORM_ORDER,
  type FormId,
  type LedgerForm,
  type LedgerRow,
  type ShiftsForm,
} from '../lib/forms';
import { cardBracketCount, withCardBrackets } from '../lib/cardMachines';
import { parseCents, splitFigureOrNote, type Cents } from '../lib/money';
import {
  MAX_ITEM_NAME,
  MAX_ITEM_QTY,
  MAX_RECEIPT_ITEMS,
  itemsToDbJson,
  type ReceiptItem,
} from '../lib/receiptItems';
import {
  MAX_CUSTOM_LABEL,
  MAX_CUSTOM_LINES,
  customLineKey,
  duplicateLabel,
  isCustomLineKey,
  labelFromCustomKey,
  normaliseCustomLabel,
} from '../lib/customLine';
import { computeLedger, computeShift, type ShiftTotals } from '../lib/compute';
import {
  MSG_DATE,
  MSG_MANAGER,
  MSG_SIGNATURE,
  MSG_ONLY_NUMBERS,
  MSG_TOO_BIG,
  MSG_CORRECTION_REASON,
  MSG_NOT_ALLOWED,
  MSG_ADMIN_REQUIRED,
  MSG_APPROVED_ADMIN_ONLY,
  MSG_GENERIC,
  missingHeader,
  MSG_LINE_NEEDS_NAME,
  MSG_LINE_DUPLICATE,
  MSG_LINE_TOO_LONG,
} from '../lib/messages';

export {
  MSG_DATE,
  MSG_MANAGER,
  MSG_SIGNATURE,
  MSG_ONLY_NUMBERS,
  MSG_TOO_BIG,
  MSG_CORRECTION_REASON,
  MSG_NOT_ALLOWED,
  MSG_GENERIC,
  missingHeader,
};

// ── Result ────────────────────────────────────────────────────────────────

export type SaveReportErrorCode =
  | 'posted_total'
  | 'invalid_payload'
  | 'missing_fields'
  | 'unknown_restaurant'
  | 'wrong_layout'
  | 'unknown_row'
  | 'not_authorised'
  | 'admin_required'
  | 'correction_reason_required'
  | 'conflict';

export type ReportStatus = 'draft' | 'submitted' | 'approved';

export interface SaveReportFailure {
  ok: false;
  error: SaveReportErrorCode;
  /** What to show the person filling the sheet. Greek, plain instructions. */
  messages: string[];
  /** Header for the live list; only set when something is missing. */
  header?: string;
  /** Developer-facing specifics. Never shown to a manager. */
  details?: string[];
  /** Present when error is 'not_authorised'. */
  reason?: Extract<AuthzDecision, { allowed: false }>['reason'];
}

export interface SaveReportSuccess {
  ok: true;
  reportId: string;
  revisionNo: number;
  status: ReportStatus;
  /** Recomputed here, from the raw inputs. Never what the client sent. */
  expectedCents: Cents;
  actualCents: Cents;
  varianceCents: Cents;
}

export type SaveReportResult = SaveReportSuccess | SaveReportFailure;

export interface SaveReportDeps {
  /** Already authenticated by the caller. Producing it is not this module's job. */
  session: Session | null;
  /** Injectable for tests; defaults to real time. Only used for session expiry. */
  now?: Date;
}

// ── Rejecting a posted total ──────────────────────────────────────────────
//
// NEXT_STEP asks for expected_cents / actual_cents / variance_cents to be
// rejected rather than ignored. The rule implemented is wider and keyed on
// what the value IS rather than on three spellings of its name: every amount
// in this contract is a string of what the manager typed, so ANY key naming
// cents is either a total the server owes itself, or an amount already
// parsed by a client that may not parse the way src/lib/money.ts does. The
// prototype's `1.234` bug was exactly a divergent parse; there is one parser
// here and the client does not get to skip it.
//
// The scan is depth-first over the whole payload, because a total nested in
// an expense line is the same bug as one at the top level.

const COMPUTED_AMOUNT_KEY = /cents/i;
const MAX_SCAN_DEPTH = 32;

function findPostedTotals(value: unknown, path = 'payload', depth = 0, seen = new WeakSet<object>()): string[] {
  if (depth > MAX_SCAN_DEPTH || value === null || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => found.push(...findPostedTotals(item, `${path}[${i}]`, depth + 1, seen)));
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (COMPUTED_AMOUNT_KEY.test(key)) found.push(childPath);
    found.push(...findPostedTotals(child, childPath, depth + 1, seen));
  }
  return found;
}

// ── Payload schema ────────────────────────────────────────────────────────
//
// Every object is .strict(): an unrecognised key at a financial boundary is
// a mistake to surface, not a field to drop silently.
//
// Amounts are strings and are NOT range-checked here — SPEC.md §2 is
// explicit that there is no upper limit on an amount, because a big number
// is usually a real day. The one bound applied (in toCents below) is that
// the parsed value must be an exact integer, which is a representability
// rule, not a policy ceiling: beyond 2^53 cents JavaScript would silently
// round the figure before Postgres ever saw it.
//
// The array caps are row counts, not money limits. The paper has 14 expense
// rows and at most 6 order slots; 200 and 32 are far past any real sheet and
// exist only so a malformed payload cannot make the server build an
// unbounded statement.

const Amount = z.string().max(40);
const ShortText = z.string().max(200);

/**
 * One line of a receipt's breakdown. `amount` is a string like every other
 * amount in this contract — parsed here, by the one parser — and the caps
 * are the ones the form enforces (src/lib/receiptItems.ts).
 */
const ReceiptItemSchema = z
  .object({
    name: z.string().max(MAX_ITEM_NAME).default(''),
    qty: z.string().max(MAX_ITEM_QTY).default(''),
    amount: Amount.default(''),
  })
  .strict();
const ReceiptItemsSchema = z.array(ReceiptItemSchema).max(MAX_RECEIPT_ITEMS).default([]);

const ExpenseLineSchema = z
  .object({
    description: ShortText.default(''),
    amount: Amount.default(''),
    /**
     * The R2 object key of a receipt photo, not a URL. The bucket is
     * private and every read is a short-lived signed URL, so a stored URL
     * would be expired by the time anyone opened the report. This is also
     * the join into the AI invoicing project — see the schema doc §7.
     */
    receiptPhotoUrl: z.string().max(2000).default(''),
    /**
     * Read off the receipt, or typed. `description` stays separate and is
     * not a fallback for this: what was bought is a different fact from
     * who sold it, and the paper ledger has people writing both.
     */
    supplier: ShortText.default(''),
    invoiceNumber: ShortText.default(''),
    /** YYYY-MM-DD, or '' — see asReceiptDate. */
    invoiceDate: z.string().max(32).default(''),
    /** What the receipt lists. Never part of the night's arithmetic. */
    items: ReceiptItemsSchema,
  })
  .strict();

const ChequeSchema = z
  .object({
    amount: Amount.default(''),
    customerName: ShortText.default(''),
    customerPhone: ShortText.default(''),
    chequeNumber: ShortText.default(''),
    bank: ShortText.default(''),
    photoUrl: z.string().max(2000).default(''),
  })
  .strict();

const PendingReceiptSchema = z
  .object({
    amount: Amount.default(''),
    organisationName: ShortText.default(''),
    contactPerson: ShortText.default(''),
    contactPhone: ShortText.default(''),
    receiptNumber: ShortText.default(''),
    photoUrl: z.string().max(2000).default(''),
  })
  .strict();

const LedgerPayloadSchema = z
  .object({
    /** row_key -> the amount as typed. Keys checked against the form config. */
    values: z.record(z.string().max(64), Amount).default({}),
    /** row_key -> label, only for the Chopsticks row printed without one. */
    labels: z.record(z.string().max(64), ShortText).default({}),
    /** row_key -> the α)…ε) order slots beside that row. */
    slots: z.record(z.string().max(64), z.array(Amount).max(32)).default({}),
    expenses: z.array(ExpenseLineSchema).max(200).default([]),
    cheques: z.array(ChequeSchema).max(200).default([]),
    pendingReceipts: z.array(PendingReceiptSchema).max(200).default([]),
    /** What the manager physically counted into the envelope. A raw input. */
    counted: Amount.default(''),
    /**
     * Named extra lines — the printed write-in row continued into a
     * list. Only accepted on a sheet whose config allows them.
     */
    customLines: z
      .array(z.object({ label: ShortText.default(''), amount: Amount.default('') }).strict())
      .max(MAX_CUSTOM_LINES)
      .default([]),
  })
  .strict();

const ShiftInvoiceSchema = z
  .object({
    supplier: ShortText.default(''),
    invoiceNumber: ShortText.default(''),
    amount: Amount.default(''),
    receiptPhotoUrl: z.string().max(2000).default(''),
    /** YYYY-MM-DD, or '' — see asReceiptDate. */
    invoiceDate: z.string().max(32).default(''),
    /** What the receipt lists. Never part of the night's arithmetic. */
    items: ReceiptItemsSchema,
  })
  .strict();

const ShiftPayloadSchema = z
  .object({
    shiftIndex: z.number().int().min(0).max(2),
    /** May be a figure OR words — see splitFigureOrNote. Not Amount. */
    dineIn: ShortText.default(''),
    ta: ShortText.default(''),
    /** The ΤΑΜΕΙΟ Total for the column. A raw input, not a computed total.
     *  Still Amount: this is the figure the night reconciles against. */
    total: Amount.default(''),
    methods: z.record(z.string().max(64), Amount).default({}),
  })
  .strict();

const SaveReportInputSchema = z
  .object({
    restaurantId: z.string().max(64),
    /** The trading day. A shift closing at 01:30 belongs to the day before. */
    businessDate: z.string().max(32).default(''),
    closingManagerName: ShortText.default(''),
    signature: z.string().max(1_000_000).default(''),
    sourcePhotoUrl: z.string().max(2000).default(''),
    status: z.enum(['draft', 'submitted', 'approved']).optional(),
    /** Required only when correcting an already-approved report. */
    correctionReason: z.string().max(1000).default(''),
    ledger: LedgerPayloadSchema.optional(),
    shifts: z.array(ShiftPayloadSchema).max(3).optional(),
    /**
     * The night's invoices. One list for the day, not one per shift: the
     * paper writes them once and braces them to a single figure, and
     * nothing on it says which till paid which receipt.
     */
    invoices: z.array(ShiftInvoiceSchema).max(200).default([]),
    /**
     * Named extra rows — the blank line under SKASH with "ΝΙΜΑ" on it.
     * One label for the night, one amount per shift column, matching the
     * printed row. Only accepted on a form whose config allows them.
     */
    customLines: z
      .array(
        z
          .object({
            label: ShortText.default(''),
            amounts: z.array(Amount).max(3).default([]),
          })
          .strict()
      )
      .max(MAX_CUSTOM_LINES)
      .default([]),
  })
  .strict();

export type SaveReportInput = z.infer<typeof SaveReportInputSchema>;

// ── Amount parsing ────────────────────────────────────────────────────────

/**
 * What a manager may type into a money field. No minus sign: the paper has
 * no negative entry, and every amount column in the schema is
 * CHECK (amount_cents >= 0), so a negative input would surface as a
 * constraint violation instead of an instruction. The computed figures
 * (expected cash, variance, difference) may of course go negative — they
 * are not inputs and are not parsed here.
 */
const ALLOWED_AMOUNT_CHARS = /^[0-9.,\s€]*$/;

interface AmountProblem {
  path: string;
  message: string;
}

function makeAmountParser() {
  const problems: AmountProblem[] = [];
  function toCents(raw: string, path: string): Cents {
    if (!ALLOWED_AMOUNT_CHARS.test(raw)) {
      problems.push({ path, message: MSG_ONLY_NUMBERS });
      return 0;
    }
    const cents = parseCents(raw);
    if (!Number.isSafeInteger(cents)) {
      problems.push({ path, message: MSG_TOO_BIG });
      return 0;
    }
    return cents;
  }
  return { problems, toCents };
}

function isRealBusinessDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day
  );
}

/**
 * A receipt's own date, or '' — never an exception.
 *
 * This is a BACKSTOP, not the guard the person sees. The form checks the
 * date and says so on the row; this exists so that a nonsense value can
 * never reach the database, where the sanity CHECK in migration 0004 would
 * refuse the INSERT and take the whole night's takings down with it.
 *
 * Dropping the date rather than failing is the right trade here. It is
 * secondary information read off a photograph; the cash reconciliation is
 * not. Refusing to record a night's takings because a scanned date was
 * misread would be the tail wagging the dog.
 *
 * The range matches the CHECK constraint deliberately: two places that
 * disagree about what is acceptable is how you get an INSERT that passes
 * validation and then fails.
 */
function asReceiptDate(value: string): string {
  const v = value.trim();
  if (!v) return '';
  if (!isRealBusinessDate(v)) return '';
  if (v < '2000-01-01' || v > '2100-01-01') return '';
  return v;
}

/**
 * A receipt's items, parsed. Blank lines are dropped here as well as in
 * the form — the form is not the only thing that can post. An amount that
 * is not a number is refused like any other (toCents records it), rather
 * than stored as nothing: silently dropping what someone typed is the one
 * thing this file never does.
 *
 * The items are NOT added up or compared with the line's amount here. They
 * are a breakdown beside the figure the night reconciles on, and a
 * difference between the two is shown to the person, never settled for
 * them (SPEC §5).
 */
function prepareItems(
  items: Array<z.infer<typeof ReceiptItemSchema>>,
  path: string,
  toCents: (raw: string, path: string) => Cents
): ReceiptItem[] {
  const out: ReceiptItem[] = [];
  items.forEach((it, i) => {
    const name = it.name.trim();
    const qty = it.qty.trim();
    const amount = it.amount.trim();
    if (name === '' && qty === '' && amount === '') return;
    out.push({
      name,
      qty,
      // No price is stored as no price, not as zero — see ReceiptItem.
      amountCents: amount === '' ? null : toCents(amount, `${path}[${i}].amount`),
    });
  });
  return out;
}

// ── Prepared write ────────────────────────────────────────────────────────

interface LedgerLineWrite {
  rowKey: string;
  labelOverride: string | null;
  amountCents: Cents;
  slots: Cents[];
}

interface PreparedLedger {
  layout: 'ledger';
  lines: LedgerLineWrite[];
  expenses: Array<{
    description: string;
    amountCents: Cents;
    receiptPhotoUrl: string;
    supplier: string;
    invoiceNumber: string;
    invoiceDate: string;
    items: ReceiptItem[];
  }>;
  cheques: Array<z.infer<typeof ChequeSchema> & { amountCents: Cents }>;
  pendingReceipts: Array<z.infer<typeof PendingReceiptSchema> & { amountCents: Cents }>;
}

interface PreparedShift {
  shiftIndex: number;
  /** Taken from the form config, never from the client. */
  label: string;
  dineInCents: Cents;
  /** Words, when the box held words. Empty when it held a figure. */
  dineInNote: string;
  taCents: Cents;
  taNote: string;
  totalCents: Cents;
  methods: Array<{ methodKey: string; amountCents: Cents }>;
  totals: ShiftTotals;
}

interface PreparedShifts {
  layout: 'shifts';
  shifts: PreparedShift[];
  invoices: Array<{
    supplier: string;
    invoiceNumber: string;
    amountCents: Cents;
    receiptPhotoUrl: string;
    invoiceDate: string;
    items: ReceiptItem[];
  }>;
  invoiceCents: Cents;
}

interface Prepared {
  input: SaveReportInput;
  restaurantId: FormId;
  expectedCents: Cents;
  actualCents: Cents;
  body: PreparedLedger | PreparedShifts;
}

function fail(
  error: SaveReportErrorCode,
  messages: string[],
  extra: Partial<SaveReportFailure> = {}
): SaveReportFailure {
  return { ok: false, error, messages, ...extra };
}

/**
 * Everything that can be decided without touching the database. Kept
 * separate from the write so the recomputation is directly testable, and so
 * a malformed payload never costs a pool connection.
 */
function prepare(payload: unknown): Prepared | SaveReportFailure {
  // First, before anything else: a total posted by the browser. Loudest bug,
  // so it is checked on the raw payload, before Zod has a chance to strip or
  // coerce it away.
  const posted = findPostedTotals(payload);
  if (posted.length > 0) {
    return fail('posted_total', [MSG_GENERIC], {
      details: [
        'the client posted a computed amount; the server recomputes every total from raw inputs and will not accept one',
        ...posted,
      ],
    });
  }

  const parsed = SaveReportInputSchema.safeParse(payload);
  if (!parsed.success) {
    return fail('invalid_payload', [MSG_GENERIC], {
      details: parsed.error.issues.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`),
    });
  }
  const input = parsed.data;

  if (!(FORM_ORDER as readonly string[]).includes(input.restaurantId)) {
    return fail('unknown_restaurant', [MSG_GENERIC], {
      details: [`unknown restaurantId "${input.restaurantId}"`],
    });
  }
  const restaurantId = input.restaurantId as FormId;
  // The sheet as the manager filled it in, card brackets included. How
  // many brackets is read off the keys sent — CARD_1 … CARD_n — exactly as
  // the browser derives it, and the form is rebuilt from that count by the
  // same function; every amount is then validated and recomputed against
  // it like any other row. A key past the ceiling is not a bracket, so it
  // stays unknown and is refused below.
  const form = withCardBrackets(
    FORMS[restaurantId],
    cardBracketCount([
      ...Object.keys(input.ledger?.values ?? {}),
      ...(input.shifts ?? []).flatMap((s) => Object.keys(s.methods)),
    ])
  );

  // SPEC.md §5's three required things. A draft is exempt from the manager
  // and signature — 0001_init.sql leaves those columns nullable precisely so
  // an incomplete draft can be stored, and puts the gate here. The business
  // date is required either way: it is the record key.
  const status: ReportStatus = input.status ?? 'submitted';
  const missing: string[] = [];
  if (!isRealBusinessDate(input.businessDate.trim())) missing.push(MSG_DATE);
  if (status !== 'draft') {
    if (!input.closingManagerName.trim()) missing.push(MSG_MANAGER);
    if (!input.signature.trim()) missing.push(MSG_SIGNATURE);
  }
  if (missing.length > 0) {
    return fail('missing_fields', missing, { header: missingHeader(missing.length) });
  }

  // Which layout applies is the restaurant's, not the client's choice.
  if (form.layout === 'ledger') {
    if (!input.ledger || input.shifts) {
      return fail('wrong_layout', [MSG_GENERIC], {
        details: [`${restaurantId} is a ledger sheet; expected a "ledger" block and no "shifts"`],
      });
    }
    return prepareLedger(input, restaurantId, form);
  }
  if (!input.shifts || input.ledger) {
    return fail('wrong_layout', [MSG_GENERIC], {
      details: [`${restaurantId} is a shifts sheet; expected a "shifts" block and no "ledger"`],
    });
  }
  return prepareShifts(input, restaurantId, form);
}

type LedgerInputRow = Extract<LedgerRow, { kind: 'input' }>;

function prepareLedger(
  input: SaveReportInput,
  restaurantId: FormId,
  form: LedgerForm
): Prepared | SaveReportFailure {
  const ledger = input.ledger!;
  const inputRows = form.rows.filter((r): r is LedgerInputRow => r.kind === 'input');
  const byKey = new Map(inputRows.map((r) => [r.key, r]));

  // A group's PARTS carry the figures; the group itself is a computed
  // total nobody types into, so its key is deliberately absent here. A
  // payload trying to set it is refused, which is what keeps the stored
  // total from ever disagreeing with the parts it is made of.
  const groupChildren = form.rows.flatMap((r) => (r.kind === 'group' ? r.children : []));
  const valueKeys = new Set([...inputRows.map((r) => r.key), ...groupChildren.map((c) => c.key)]);

  const unknown: string[] = [];

  for (const key of Object.keys(ledger.values)) {
    if (!valueKeys.has(key)) unknown.push(`values.${key}`);
  }
  for (const key of Object.keys(ledger.slots)) {
    const row = byKey.get(key);
    if (!row) unknown.push(`slots.${key}`);
    else if (!row.slots) unknown.push(`slots.${key} (this row has no order slots on the paper)`);
    else if ((ledger.slots[key] ?? []).length > row.slots) {
      unknown.push(`slots.${key} (the paper prints ${row.slots} slots)`);
    }
  }
  for (const key of Object.keys(ledger.labels)) {
    const row = byKey.get(key);
    if (!row) unknown.push(`labels.${key}`);
    else if (!row.editableLabel) unknown.push(`labels.${key} (this row's label is printed, not writable)`);
  }
  if (unknown.length > 0) {
    return fail('unknown_row', [MSG_GENERIC], {
      details: [`rows that do not exist on ${restaurantId}'s sheet:`, ...unknown],
    });
  }

  // ── Named lines ───────────────────────────────────────────────────
  // Vetted before any amount is parsed, so a line that is going to be
  // refused does not also raise amount errors for figures nobody keeps.
  const rawCustom = ledger.customLines ?? [];
  const touched = (l: { label: string; amount: string }) =>
    normaliseCustomLabel(l.label) !== '' || l.amount.trim() !== '';

  if (!form.allowCustomLines && rawCustom.some(touched)) {
    return fail('unknown_row', [MSG_GENERIC], {
      details: [`${restaurantId}'s sheet has no named lines`],
    });
  }

  const lineMessages: string[] = [];
  const lineDetails: string[] = [];
  const vettedCustom: Array<{ label: string; amount: string }> = [];

  rawCustom.forEach((l, i) => {
    const label = normaliseCustomLabel(l.label);
    const hasAmount = l.amount.trim() !== '';
    // The untouched spare. Every sheet carries one, so this is normal.
    if (label === '' && !hasAmount) return;
    if (label === '') {
      lineMessages.push(MSG_LINE_NEEDS_NAME);
      lineDetails.push(`ledger.customLines[${i}]: amount with no label`);
      return;
    }
    // Checked BEFORE the slice inside normaliseCustomLabel: silently
    // storing a truncated name changes which line the money is under.
    if (l.label.replace(/\s+/g, ' ').trim().length > MAX_CUSTOM_LABEL) {
      lineMessages.push(MSG_LINE_TOO_LONG);
      lineDetails.push(`ledger.customLines[${i}]: label longer than ${MAX_CUSTOM_LABEL}`);
      return;
    }
    vettedCustom.push({ label, amount: l.amount });
  });

  // Against the printed rows too, not just each other: a named line
  // called the same as a row already on the sheet would put one night's
  // takings on two lines and read as double the money.
  const printed = new Set(
    form.rows
      .filter((r) => r.kind === 'input' || r.kind === 'group')
      .map((r) => r.label.trim().toUpperCase())
      .filter((l) => l !== '')
  );
  for (const v of vettedCustom) {
    if (printed.has(v.label.toUpperCase())) {
      lineMessages.push(MSG_LINE_DUPLICATE);
      lineDetails.push(`ledger.customLines: ${JSON.stringify(v.label)} is already a printed row`);
    }
  }

  const dupLine = duplicateLabel(vettedCustom.map((v) => v.label));
  if (dupLine !== null) {
    lineMessages.push(MSG_LINE_DUPLICATE);
    lineDetails.push(`ledger.customLines: duplicate label ${JSON.stringify(dupLine)}`);
  }

  if (lineMessages.length > 0) {
    return fail('invalid_payload', [...new Set(lineMessages)], { details: lineDetails });
  }

  const { problems, toCents } = makeAmountParser();

  // Every input row the form defines gets a stored line, whether or not the
  // client sent it. A blank row on the paper is a real, blank row; storing
  // only the rows that happened to arrive would make "not filled in" and
  // "not sent" indistinguishable when the archive is read back.
  const lines: LedgerLineWrite[] = [
    ...inputRows.map((row) => {
      const slots = (ledger.slots[row.key] ?? []).map((s, i) =>
        toCents(s, `ledger.slots.${row.key}[${i}]`)
      );
      // The row keeps the figure it was sent, even when the α)…ε) boxes
      // below it add up to something else.
      //
      // Deriving it from the slots here was tried and reverted. It reads
      // like an improvement and is not: this sheet records what the
      // person wrote, and SPEC.md §5 has it show a disagreement rather
      // than settle one. A manager who writes 84,80 on the row and
      // itemises 41,00 beneath it has told you two things, and the one
      // worth keeping is that they do not match — replacing the row with
      // the sum throws that away and calls it arithmetic.
      //
      // The browser fills the row in as the slots are typed, so a sheet
      // filled in normally never sends a disagreement it created. What
      // arrives here disagreeing came from an older night, a stale
      // draft, or a client that made it up, and none of those are for
      // this function to overrule.
      return {
        rowKey: row.key,
        labelOverride: row.editableLabel ? (ledger.labels[row.key] ?? '').trim() || null : null,
        amountCents: toCents(ledger.values[row.key] ?? '', `ledger.values.${row.key}`),
        slots,
      };
    }),
    // Each part of a group is a stored line in its own right, so the
    // archive can say how much came through Bamboo and how much through
    // Chopsticks. The group total is not stored: it is derived, and
    // storing a derived figure is how two numbers start to disagree.
    ...groupChildren.map((child) => ({
      rowKey: child.key,
      labelOverride: null,
      amountCents: toCents(ledger.values[child.key] ?? '', `ledger.values.${child.key}`),
      slots: [] as Cents[],
    })),
    // A named line is stored under its own name behind the reserved
    // prefix — the same scheme as the shifts sheet, so one rule covers
    // both — and carries the label as written for the archive to print.
    ...vettedCustom.map((l, i) => ({
      rowKey: customLineKey(l.label),
      labelOverride: l.label,
      amountCents: toCents(l.amount, `ledger.customLines[${i}].amount`),
      slots: [] as Cents[],
    })),
  ];

  const expenses = ledger.expenses.map((e, i) => ({
    description: e.description,
    amountCents: toCents(e.amount, `ledger.expenses[${i}].amount`),
    receiptPhotoUrl: e.receiptPhotoUrl,
    supplier: e.supplier,
    invoiceNumber: e.invoiceNumber,
    invoiceDate: asReceiptDate(e.invoiceDate),
    items: prepareItems(e.items, `ledger.expenses[${i}].items`, toCents),
  }));
  const cheques = ledger.cheques.map((c, i) => ({
    ...c,
    amountCents: toCents(c.amount, `ledger.cheques[${i}].amount`),
  }));
  const pendingReceipts = ledger.pendingReceipts.map((p, i) => ({
    ...p,
    amountCents: toCents(p.amount, `ledger.pendingReceipts[${i}].amount`),
  }));
  const countedCents = toCents(ledger.counted, 'ledger.counted');

  if (problems.length > 0) return amountFailure(problems);

  const totals = computeLedger(form, {
    // Printed rows only. The named lines are passed separately below,
    // because computeLedger keys `values` off the form config on purpose
    // — a free-text key in there would be silently ignored, and a
    // deduction that is silently ignored is money the sheet says is in
    // the till when it is not.
    values: Object.fromEntries(
      lines.filter((l) => !isCustomLineKey(l.rowKey)).map((l) => [l.rowKey, l.amountCents])
    ),
    customLines: lines
      .filter((l) => isCustomLineKey(l.rowKey))
      .map((l) => ({ label: labelFromCustomKey(l.rowKey), cents: l.amountCents })),
    expenses: expenses.map((e) => ({ description: e.description, cents: e.amountCents })),
    countedCents,
  });

  return {
    input,
    restaurantId,
    expectedCents: totals.expectedCents,
    actualCents: totals.countedCents,
    body: { layout: 'ledger', lines, expenses, cheques, pendingReceipts },
  };
}

function prepareShifts(
  input: SaveReportInput,
  restaurantId: FormId,
  form: ShiftsForm
): Prepared | SaveReportFailure {
  const payloadShifts = input.shifts!;
  const methodKeys = new Set(form.methods.map((m) => m.key));
  const unknown: string[] = [];
  const seenIndexes = new Set<number>();

  for (const s of payloadShifts) {
    if (seenIndexes.has(s.shiftIndex)) unknown.push(`shifts: shiftIndex ${s.shiftIndex} sent twice`);
    seenIndexes.add(s.shiftIndex);
    for (const key of Object.keys(s.methods)) {
      if (!methodKeys.has(key)) unknown.push(`shifts[${s.shiftIndex}].methods.${key}`);
    }
  }
  if (unknown.length > 0) {
    return fail('unknown_row', [MSG_GENERIC], {
      details: [`rows that do not exist on ${restaurantId}'s sheet:`, ...unknown],
    });
  }

  // ── Named rows ────────────────────────────────────────────────────
  // Vetted once for the night, before any amount is parsed, because a
  // line that is going to be refused should not also produce amount
  // errors for figures nobody will keep.
  const rawCustom = input.customLines ?? [];
  const touched = (l: { label: string; amounts: string[] }) =>
    normaliseCustomLabel(l.label) !== '' || l.amounts.some((a) => (a ?? '').trim() !== '');

  if (!form.allowCustomLines && rawCustom.some(touched)) {
    return fail('unknown_row', [MSG_GENERIC], {
      details: [`${restaurantId}'s sheet has no named rows`],
    });
  }

  const lineMessages: string[] = [];
  const lineDetails: string[] = [];
  const vettedCustom: Array<{ label: string; amounts: string[] }> = [];

  rawCustom.forEach((l, i) => {
    const label = normaliseCustomLabel(l.label);
    const hasAmount = l.amounts.some((a) => (a ?? '').trim() !== '');
    // An untouched spare row. The sheet always carries one, so this is
    // the normal case, not an error.
    if (label === '' && !hasAmount) return;
    if (label === '') {
      lineMessages.push(MSG_LINE_NEEDS_NAME);
      lineDetails.push(`customLines[${i}]: amount with no label`);
      return;
    }
    // Compare BEFORE the slice in normaliseCustomLabel: silently saving
    // a truncated name would change which row the money is filed under.
    if (l.label.replace(/\s+/g, ' ').trim().length > MAX_CUSTOM_LABEL) {
      lineMessages.push(MSG_LINE_TOO_LONG);
      lineDetails.push(`customLines[${i}]: label longer than ${MAX_CUSTOM_LABEL}`);
      return;
    }
    vettedCustom.push({ label, amounts: l.amounts });
  });

  const dup = duplicateLabel(vettedCustom.map((v) => v.label));
  if (dup !== null) {
    lineMessages.push(MSG_LINE_DUPLICATE);
    lineDetails.push(`customLines: duplicate label ${JSON.stringify(dup)}`);
  }

  if (lineMessages.length > 0) {
    return fail('invalid_payload', [...new Set(lineMessages)], { details: lineDetails });
  }

  const { problems, toCents } = makeAmountParser();

  const shifts: PreparedShift[] = payloadShifts.map((s) => {
    const p = `shifts[${s.shiftIndex}]`;
    const methods = form.methods.map((m) => ({
      methodKey: m.key,
      amountCents: toCents(s.methods[m.key] ?? '', `${p}.methods.${m.key}`),
    }));
    // Same shape as a method for storage — zet_shift_payment takes the
    // key as free text — but kept out of entry.methods below, which is
    // keyed strictly off the config on purpose.
    const custom = vettedCustom.map((l, li) => ({
      label: l.label,
      methodKey: customLineKey(l.label),
      amountCents: toCents(l.amounts[s.shiftIndex] ?? '', `customLines[${li}][${s.shiftIndex}]`),
    }));
    // A note is not an amount error: these two boxes are allowed to hold
    // words, so they never reach toCents and never raise «Μόνο αριθμοί».
    const dineIn = splitFigureOrNote(s.dineIn);
    const ta = splitFigureOrNote(s.ta);
    const entry = {
      dineInCents: dineIn.note === '' ? toCents(s.dineIn, `${p}.dineIn`) : 0,
      dineInNote: dineIn.note,
      taCents: ta.note === '' ? toCents(s.ta, `${p}.ta`) : 0,
      taNote: ta.note,
      totalCents: toCents(s.total, `${p}.total`),
      methods: Object.fromEntries(methods.map((m) => [m.methodKey, m.amountCents])),
      customLines: custom.map((c) => ({ label: c.label, cents: c.amountCents })),
      // A shift's own total is its cash. See the day figures below.
      invoices: [],
    };
    return {
      shiftIndex: s.shiftIndex,
      // The column heading is the form's, not the client's.
      label: form.shifts[s.shiftIndex] ?? form.shifts[0],
      dineInCents: entry.dineInCents,
      dineInNote: entry.dineInNote,
      taCents: entry.taCents,
      taNote: entry.taNote,
      totalCents: entry.totalCents,
      methods: [
        ...methods,
        ...custom.map((c) => ({ methodKey: c.methodKey, amountCents: c.amountCents })),
      ],
      totals: computeShift(form, entry),
    };
  });

  if (problems.length > 0) return amountFailure(problems);

  const invoices = (input.invoices ?? []).map((inv, i) => ({
    supplier: inv.supplier,
    invoiceNumber: inv.invoiceNumber,
    receiptPhotoUrl: inv.receiptPhotoUrl,
    invoiceDate: asReceiptDate(inv.invoiceDate),
    amountCents: toCents(inv.amount, `invoices[${i}].amount`),
    items: prepareItems(inv.items, `invoices[${i}].items`, toCents),
  }));
  const invoiceCents = invoices.reduce((a, inv) => a + inv.amountCents, 0);

  if (problems.length > 0) return amountFailure(problems);

  // Day figures are the sums across shifts (SPEC.md §4). actual_cents is
  // still the accounted side — cash plus the invoices paid out of the
  // till, matching the column the paper prints as TOTAL — but the
  // invoices are added ONCE, here, because the sheet settles them against
  // the day rather than against a shift. For a night where only one shift
  // carried figures the arithmetic is unchanged, which is why the
  // reconciled 10/09/26 fixture still reads 543,40 and 105,02 short.
  const expectedCents = shifts.reduce((a, s) => a + s.totals.expectedCents, 0);
  const actualCents = shifts.reduce((a, s) => a + s.totals.accountedCents, 0) + invoiceCents;

  return {
    input,
    restaurantId,
    expectedCents,
    actualCents,
    body: { layout: 'shifts', shifts, invoices, invoiceCents },
  };
}

function amountFailure(problems: AmountProblem[]): SaveReportFailure {
  const unique = [...new Set(problems.map((p) => p.message))];
  return fail('invalid_payload', unique, {
    details: problems.map((p) => `${p.path}: ${p.message}`),
  });
}

// ── The action ────────────────────────────────────────────────────────────

export async function saveDailyReport(
  payload: unknown,
  deps: SaveReportDeps
): Promise<SaveReportResult> {
  const prepared = prepare(payload);
  if ('ok' in prepared) return prepared;

  const { session } = deps;
  const now = deps.now ?? new Date();

  // Session shape is checked before opening a transaction so an anonymous
  // or expired caller never costs a pool connection. The real decision is
  // still made by authorizeRestaurantAccess inside the transaction, against
  // a freshly read role — this is an early-out, not the authorisation.
  if (!session) return notAuthorised('no_session');
  if (session.expiresAt.getTime() <= now.getTime()) return notAuthorised('session_expired');

  const userId = session.userId;
  const requestedStatus: ReportStatus = prepared.input.status ?? 'submitted';

  // The two-phase approve. A report may NOT be written as 'approved' and
  // then have its children inserted in the same transaction: the child
  // guards (0002) refuse any write to an approved report's rows unless
  // zet_correction_lock holds this transaction's id, and that lock is armed
  // only by the BEFORE UPDATE trigger on zet_report when OLD.status is
  // already 'approved'. It never fires on an INSERT, and it does not fire
  // when a draft is promoted. So the header goes in un-approved, the
  // children go in while the guards are a no-op, and approval is a final
  // UPDATE issued after them — whose OLD.status is 'submitted', so the
  // archive trigger correctly stays quiet and records no revision.
  //
  // Correcting an already-approved report is the one case that does write
  // children while the report is approved, and there the lock is armed by
  // applyCorrection. That path is handled separately below.
  const writeStatus: ReportStatus = requestedStatus === 'approved' ? 'submitted' : requestedStatus;

  try {
    return await withUserTransaction(userId, async (client) => {
      // Authorise INSIDE the transaction, on the client already open. Never
      // the standalone getRestaurantRole(userId, restaurantId) overload:
      // that opens a second pool connection per request.
      const decision = await authorizeRestaurantAccess({
        session,
        restaurantId: prepared.restaurantId,
        minRole: 'write',
        now,
        getRole: (restaurantId, uid) => getRestaurantRole(client, uid, restaurantId),
      });
      if (!decision.allowed) return notAuthorised(decision.reason);

      // Approving is the admin's, by saving as much as by the Approve
      // button (src/server/approve.ts). The form never posts status
      // 'approved'; anyone with devtools can. Migration 0009 refuses it in
      // the database as well.
      if (requestedStatus === 'approved' && decision.role !== 'admin') {
        return fail('admin_required', [MSG_ADMIN_REQUIRED]);
      }

      const existing = await selectExistingForUpdate(client, prepared);

      // A restaurant edits its own night freely until it is approved; after
      // that the night is the admin's to correct (05/10/2026). Also
      // enforced by migration 0009.
      if (existing?.status === 'approved' && decision.role !== 'admin') {
        return fail('admin_required', [MSG_APPROVED_ADMIN_ONLY]);
      }

      // Correcting a report that is already approved. The header UPDATE must
      // be the first write of the transaction: it fires the archive trigger
      // (snapshotting the children as they still are) and arms the
      // txid-keyed lock that lets the child writes below through. Touching a
      // child before it is rejected with ZET01. Approval here is part of
      // that same UPDATE — the report is already approved, so the two-phase
      // dance below would be both unnecessary and wrong.
      if (existing?.status === 'approved') {
        const reason = prepared.input.correctionReason.trim();
        if (!reason) {
          return fail('correction_reason_required', [MSG_CORRECTION_REASON]);
        }
        const corrected = await applyCorrection(
          client,
          existing.id,
          prepared,
          requestedStatus,
          userId,
          reason
        );
        await writeChildren(client, existing.id, prepared);
        return success(existing.id, corrected.revisionNo, corrected.status, prepared);
      }

      const header = existing
        ? { id: existing.id, ...(await updateReport(client, existing.id, prepared, writeStatus)) }
        : await insertReport(client, prepared, writeStatus, userId);

      await writeChildren(client, header.id, prepared);

      // Phase two: only now, with every child row in place, is the report
      // allowed to become immutable.
      if (requestedStatus === 'approved') {
        const approved = await approveReport(client, header.id, userId);
        return success(header.id, approved.revisionNo, approved.status, prepared);
      }
      return success(header.id, header.revisionNo, header.status, prepared);
    });
  } catch (err) {
    // Two managers closing the same day at the same moment: the unique
    // constraint on (restaurant_id, business_date) is the arbiter, and the
    // loser gets told to reopen the day rather than a 500.
    if (isUniqueViolation(err)) {
      return fail('conflict', [MSG_GENERIC], {
        details: ['a report for this restaurant and business date was created concurrently'],
      });
    }
    throw err;
  }
}

function notAuthorised(reason: Extract<AuthzDecision, { allowed: false }>['reason']): SaveReportFailure {
  return fail('not_authorised', [MSG_NOT_ALLOWED], { reason });
}

function success(
  reportId: string,
  revisionNo: number,
  status: ReportStatus,
  prepared: Prepared
): SaveReportSuccess {
  return {
    ok: true,
    reportId,
    revisionNo,
    status,
    expectedCents: prepared.expectedCents,
    actualCents: prepared.actualCents,
    // Mirrors the generated column added in 0002: actual - expected.
    varianceCents: prepared.actualCents - prepared.expectedCents,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

// ── Statements ────────────────────────────────────────────────────────────
//
// variance_cents is never written: 0002 made it
// GENERATED ALWAYS AS (actual_cents - expected_cents) STORED, so naming it
// in an INSERT or UPDATE is rejected with SQLSTATE 428C9.

interface ExistingReport {
  id: string;
  status: ReportStatus;
  revisionNo: number;
}

async function selectExistingForUpdate(
  client: PoolClient,
  prepared: Prepared
): Promise<ExistingReport | null> {
  const { rows } = await client.query<{ id: string; status: ReportStatus; revision_no: number }>(
    `SELECT id, status, revision_no
       FROM zet_report
      WHERE restaurant_id = $1 AND business_date = $2
      FOR UPDATE`,
    [prepared.restaurantId, prepared.input.businessDate.trim()]
  );
  const row = rows[0];
  return row ? { id: row.id, status: row.status, revisionNo: row.revision_no } : null;
}

/**
 * A brand-new report. Never inserted as 'approved' — see the two-phase
 * approve note in saveDailyReport: children could not be written afterwards.
 */
async function insertReport(
  client: PoolClient,
  prepared: Prepared,
  status: Exclude<ReportStatus, 'approved'>,
  userId: string
): Promise<{ id: string; revisionNo: number; status: ReportStatus }> {
  const i = prepared.input;
  const { rows } = await client.query<{ id: string; revision_no: number; status: ReportStatus }>(
    `INSERT INTO zet_report
       (restaurant_id, business_date, status, closing_manager_name, signature_url,
        source_photo_url, expected_cents, actual_cents, created_by, submitted_at)
     VALUES
       ($1, $2, $3::report_status, NULLIF($4,''), NULLIF($5,''),
        NULLIF($6,''), $7, $8, $9,
        CASE WHEN $3::report_status = 'submitted' THEN now() END)
     RETURNING id, revision_no, status`,
    [
      prepared.restaurantId,
      i.businessDate.trim(),
      status,
      i.closingManagerName.trim(),
      i.signature.trim(),
      i.sourcePhotoUrl.trim(),
      prepared.expectedCents,
      prepared.actualCents,
      userId,
    ]
  );
  const row = rows[0];
  if (!row) throw new Error('INSERT INTO zet_report returned no row');
  return { id: row.id, revisionNo: row.revision_no, status: row.status };
}

/**
 * A report that has not been approved is edited in place — it is not yet a
 * signed record, so there is nothing to archive.
 *
 * This never writes status = 'approved': its caller passes writeStatus, and
 * approval is always the separate second phase in approveReport. Handling
 * approval here as well would put a branch in a financial write path that
 * can never be taken, which is exactly the kind of thing a later reader
 * copies believing it works.
 */
async function updateReport(
  client: PoolClient,
  reportId: string,
  prepared: Prepared,
  status: Exclude<ReportStatus, 'approved'>
): Promise<{ revisionNo: number; status: ReportStatus }> {
  const i = prepared.input;
  const { rows } = await client.query<{ revision_no: number; status: ReportStatus }>(
    `UPDATE zet_report SET
       status = $2::report_status,
       closing_manager_name = NULLIF($3,''),
       signature_url = NULLIF($4,''),
       source_photo_url = NULLIF($5,''),
       expected_cents = $6,
       actual_cents = $7,
       submitted_at = CASE WHEN $2::report_status = 'submitted'
                           THEN COALESCE(submitted_at, now()) ELSE submitted_at END
     WHERE id = $1
     RETURNING revision_no, status`,
    [
      reportId,
      status,
      i.closingManagerName.trim(),
      i.signature.trim(),
      i.sourcePhotoUrl.trim(),
      prepared.expectedCents,
      prepared.actualCents,
    ]
  );
  const row = rows[0];
  if (!row) throw new Error('UPDATE zet_report matched no row');
  return { revisionNo: row.revision_no, status: row.status };
}

/**
 * Phase two of a save that approves: flip an already-written report to
 * 'approved', after its child rows are in place.
 *
 * OLD.status here is whatever writeStatus put in — never 'approved' — so
 * zet_report_archive_before_correction sees a plain status transition,
 * archives nothing and demands no correction_reason. Approving is not a
 * correction; there is no earlier signed version of this report to keep.
 *
 * approved_by is recorded separately from created_by even though, per
 * NEXT_STEP, anyone who may write may also approve their own report: if
 * that policy ever tightens, the archive can tell the two apart only if
 * they were stored apart to begin with.
 */
async function approveReport(
  client: PoolClient,
  reportId: string,
  userId: string
): Promise<{ revisionNo: number; status: ReportStatus }> {
  const { rows } = await client.query<{ revision_no: number; status: ReportStatus }>(
    `UPDATE zet_report SET
       status = 'approved',
       approved_at = now(),
       approved_by = $2::uuid
     WHERE id = $1
     RETURNING revision_no, status`,
    [reportId, userId]
  );
  const row = rows[0];
  if (!row) throw new Error('approve UPDATE matched no row');
  return { revisionNo: row.revision_no, status: row.status };
}

/**
 * The correction protocol, as one statement, deliberately.
 *
 * zet_report_archive_before_correction (0003) refuses this UPDATE unless
 * revision_no rises and correction_reason + correction_by are both set. When
 * it accepts, it archives the pre-correction snapshot into
 * zet_report_revision and records (report_id, pg_current_xact_id()) in
 * zet_correction_lock. Only then do the child guards let this transaction
 * write to an approved report's rows.
 *
 * So the ordering is not a convention the caller should remember — it is the
 * only order the database permits. Calling writeChildren before this
 * function raises SQLSTATE ZET01.
 */
async function applyCorrection(
  client: PoolClient,
  reportId: string,
  prepared: Prepared,
  status: ReportStatus,
  userId: string,
  reason: string
): Promise<{ revisionNo: number; status: ReportStatus }> {
  const i = prepared.input;
  const { rows } = await client.query<{ revision_no: number; status: ReportStatus }>(
    `UPDATE zet_report SET
       revision_no = revision_no + 1,
       correction_reason = $2,
       correction_by = $3::uuid,
       status = $4::report_status,
       closing_manager_name = NULLIF($5,''),
       signature_url = NULLIF($6,''),
       source_photo_url = NULLIF($7,''),
       expected_cents = $8,
       actual_cents = $9,
       approved_at = CASE WHEN $4::report_status = 'approved' THEN now() ELSE approved_at END,
       approved_by = CASE WHEN $4::report_status = 'approved' THEN $3::uuid ELSE approved_by END
     WHERE id = $1
     RETURNING revision_no, status`,
    [
      reportId,
      reason,
      userId,
      status,
      i.closingManagerName.trim(),
      i.signature.trim(),
      i.sourcePhotoUrl.trim(),
      prepared.expectedCents,
      prepared.actualCents,
    ]
  );
  const row = rows[0];
  if (!row) throw new Error('correction UPDATE matched no row');
  return { revisionNo: row.revision_no, status: row.status };
}

/**
 * Child rows are rewritten wholesale rather than diffed. A sheet is one
 * document; a partial update would leave a row from a previous save sitting
 * in a record nobody edited it into.
 *
 * Slots and shift children are deleted explicitly before their parents even
 * though the foreign keys cascade. A cascade deletes the parent first, so
 * the child guard's lookup of "which report does this belong to" finds
 * nothing and waves the delete through — the guard only really runs when the
 * child is deleted in its own statement.
 */
async function writeChildren(client: PoolClient, reportId: string, prepared: Prepared): Promise<void> {
  await client.query(
    `DELETE FROM zet_report_slot
      WHERE report_line_id IN (SELECT id FROM zet_report_line WHERE report_id = $1)`,
    [reportId]
  );
  await client.query('DELETE FROM zet_report_line WHERE report_id = $1', [reportId]);
  await client.query('DELETE FROM zet_expense_line WHERE report_id = $1', [reportId]);
  await client.query('DELETE FROM zet_cheque WHERE report_id = $1', [reportId]);
  await client.query('DELETE FROM zet_pending_receipt WHERE report_id = $1', [reportId]);
  await client.query(
    `DELETE FROM zet_shift_payment
      WHERE shift_id IN (SELECT id FROM zet_shift WHERE report_id = $1)`,
    [reportId]
  );
  // Keyed on the report now, not on its shifts (migration 0005).
  await client.query('DELETE FROM zet_report_invoice WHERE report_id = $1', [reportId]);
  await client.query('DELETE FROM zet_shift WHERE report_id = $1', [reportId]);

  if (prepared.body.layout === 'ledger') {
    await writeLedgerChildren(client, reportId, prepared.body);
  } else {
    await writeShiftChildren(client, reportId, prepared.body);
  }
}

async function writeLedgerChildren(
  client: PoolClient,
  reportId: string,
  body: PreparedLedger
): Promise<void> {
  const { rows: lineRows } = await client.query<{ id: string; row_key: string }>(
    `INSERT INTO zet_report_line (report_id, row_key, label_override, amount_cents)
     SELECT $1, k, l, a
       FROM unnest($2::text[], $3::text[], $4::bigint[]) AS t(k, l, a)
     RETURNING id, row_key`,
    [
      reportId,
      body.lines.map((l) => l.rowKey),
      body.lines.map((l) => l.labelOverride),
      body.lines.map((l) => l.amountCents),
    ]
  );

  const lineIdByKey = new Map(lineRows.map((r) => [r.row_key, r.id]));
  const slotLineIds: string[] = [];
  const slotIndexes: number[] = [];
  const slotAmounts: Cents[] = [];
  for (const line of body.lines) {
    const lineId = lineIdByKey.get(line.rowKey);
    if (!lineId) continue;
    line.slots.forEach((cents, index) => {
      slotLineIds.push(lineId);
      slotIndexes.push(index);
      slotAmounts.push(cents);
    });
  }
  if (slotLineIds.length > 0) {
    await client.query(
      `INSERT INTO zet_report_slot (report_line_id, slot_index, amount_cents)
       SELECT id, idx, amt
         FROM unnest($1::uuid[], $2::smallint[], $3::bigint[]) AS t(id, idx, amt)`,
      [slotLineIds, slotIndexes, slotAmounts]
    );
  }

  if (body.expenses.length > 0) {
    await client.query(
      // NULLIF('') throughout: an empty string and "no supplier" are the
      // same thing on a paper ledger, and storing '' would make every
      // later query say `WHERE supplier_name <> '' AND ... IS NOT NULL`.
      // receipt_items travels as JSON text and is cast per row: '' for a
      // line with no items, which becomes NULL like every other absence.
      `INSERT INTO zet_expense_line
         (report_id, line_no, description, amount_cents, receipt_photo_url,
          supplier_name, invoice_number, invoice_date, receipt_items)
       SELECT $1, n, NULLIF(d,''), a, NULLIF(p,''),
              NULLIF(s,''), NULLIF(inv,''), NULLIF(dt,'')::date, NULLIF(it,'')::jsonb
         FROM unnest($2::smallint[], $3::text[], $4::bigint[], $5::text[],
                     $6::text[], $7::text[], $8::text[], $9::text[])
           AS t(n, d, a, p, s, inv, dt, it)`,
      [
        reportId,
        body.expenses.map((_, i) => i + 1),
        body.expenses.map((e) => e.description),
        body.expenses.map((e) => e.amountCents),
        body.expenses.map((e) => e.receiptPhotoUrl),
        body.expenses.map((e) => e.supplier),
        body.expenses.map((e) => e.invoiceNumber),
        body.expenses.map((e) => e.invoiceDate),
        body.expenses.map((e) => itemsToDbJson(e.items)),
      ]
    );
  }

  if (body.cheques.length > 0) {
    await client.query(
      `INSERT INTO zet_cheque
         (report_id, amount_cents, customer_name, customer_phone, cheque_number, bank, photo_url)
       SELECT $1, a, NULLIF(n,''), NULLIF(p,''), NULLIF(c,''), NULLIF(b,''), NULLIF(u,'')
         FROM unnest($2::bigint[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
           AS t(a, n, p, c, b, u)`,
      [
        reportId,
        body.cheques.map((c) => c.amountCents),
        body.cheques.map((c) => c.customerName),
        body.cheques.map((c) => c.customerPhone),
        body.cheques.map((c) => c.chequeNumber),
        body.cheques.map((c) => c.bank),
        body.cheques.map((c) => c.photoUrl),
      ]
    );
  }

  if (body.pendingReceipts.length > 0) {
    await client.query(
      `INSERT INTO zet_pending_receipt
         (report_id, amount_cents, organisation_name, contact_person, contact_phone,
          receipt_number, photo_url)
       SELECT $1, a, NULLIF(o,''), NULLIF(p,''), NULLIF(t2,''), NULLIF(r,''), NULLIF(u,'')
         FROM unnest($2::bigint[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
           AS t(a, o, p, t2, r, u)`,
      [
        reportId,
        body.pendingReceipts.map((p) => p.amountCents),
        body.pendingReceipts.map((p) => p.organisationName),
        body.pendingReceipts.map((p) => p.contactPerson),
        body.pendingReceipts.map((p) => p.contactPhone),
        body.pendingReceipts.map((p) => p.receiptNumber),
        body.pendingReceipts.map((p) => p.photoUrl),
      ]
    );
  }
}

async function writeShiftChildren(
  client: PoolClient,
  reportId: string,
  body: PreparedShifts
): Promise<void> {
  if (body.shifts.length === 0) return;

  const { rows: shiftRows } = await client.query<{ id: string; shift_index: number }>(
    `INSERT INTO zet_shift
       (report_id, shift_index, label, dine_in_cents, ta_cents, total_cents,
        dine_in_note, ta_note)
     SELECT $1, i, l, d, t2, tot, dn, tn
       FROM unnest($2::smallint[], $3::text[], $4::bigint[], $5::bigint[],
                   $6::bigint[], $7::text[], $8::text[])
         AS t(i, l, d, t2, tot, dn, tn)
     RETURNING id, shift_index`,
    [
      reportId,
      body.shifts.map((s) => s.shiftIndex),
      body.shifts.map((s) => s.label),
      body.shifts.map((s) => s.dineInCents),
      body.shifts.map((s) => s.taCents),
      body.shifts.map((s) => s.totalCents),
      body.shifts.map((s) => s.dineInNote),
      body.shifts.map((s) => s.taNote),
    ]
  );

  const shiftIdByIndex = new Map(shiftRows.map((r) => [r.shift_index, r.id]));

  const payShiftIds: string[] = [];
  const payMethods: string[] = [];
  const payAmounts: Cents[] = [];
  const invLineNos: number[] = [];
  const invSuppliers: string[] = [];
  const invNumbers: string[] = [];
  const invAmounts: Cents[] = [];
  const invPhotos: string[] = [];
  const invDates: string[] = [];
  const invItems: string[] = [];

  for (const shift of body.shifts) {
    const shiftId = shiftIdByIndex.get(shift.shiftIndex);
    if (!shiftId) continue;
    for (const m of shift.methods) {
      payShiftIds.push(shiftId);
      payMethods.push(m.methodKey);
      payAmounts.push(m.amountCents);
    }
  }

  // Once for the night, against the report — not once per shift. The
  // paper's Invoices block is a single list braced to one figure.
  body.invoices.forEach((inv, i) => {
    invLineNos.push(i + 1);
    invSuppliers.push(inv.supplier);
    invNumbers.push(inv.invoiceNumber);
    invAmounts.push(inv.amountCents);
    invPhotos.push(inv.receiptPhotoUrl);
    invDates.push(inv.invoiceDate);
    invItems.push(itemsToDbJson(inv.items));
  });

  if (payShiftIds.length > 0) {
    await client.query(
      `INSERT INTO zet_shift_payment (shift_id, method_key, amount_cents)
       SELECT id, k, a FROM unnest($1::uuid[], $2::text[], $3::bigint[]) AS t(id, k, a)`,
      [payShiftIds, payMethods, payAmounts]
    );
  }
  if (invLineNos.length > 0) {
    await client.query(
      `INSERT INTO zet_report_invoice
         (report_id, line_no, supplier_name, invoice_number, amount_cents,
          receipt_photo_url, invoice_date, receipt_items)
       SELECT $1, n, NULLIF(s,''), NULLIF(inv,''), a, NULLIF(u,''), NULLIF(dt,'')::date,
              NULLIF(it,'')::jsonb
         FROM unnest($2::smallint[], $3::text[], $4::text[],
                     $5::bigint[], $6::text[], $7::text[], $8::text[])
           AS t(n, s, inv, a, u, dt, it)`,
      [reportId, invLineNos, invSuppliers, invNumbers, invAmounts, invPhotos, invDates, invItems]
    );
  }
}
