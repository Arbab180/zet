'use client';

/**
 * The ledger sheet (ΑΝΑΜΜΑ + both Chopsticks) — ONE component driven by the
 * restaurant's LedgerForm config from src/lib/forms.ts, not three
 * hand-copied components. Everything that differs between the three sheets
 * (label alignment, subtotal rows, order slots, the printed-but-blank
 * Chopsticks row, the expense block's heading text) is data on that config,
 * read here, never branched on `form.id`.
 *
 * What is NOT this component's job, and why:
 *
 * - It never computes a total that gets POSTED. src/lib/compute.ts runs
 *   here too, but only to show the manager the same running arithmetic the
 *   paper's subtotal rows show — "the arithmetic is done for them". Every
 *   value in the payload handleSave() builds is the raw string typed into
 *   an input; src/server/saveReport.ts recomputes independently from those
 *   strings and is what actually decides what gets stored (CLAUDE.md rule
 *   2). If this component's arithmetic and the server's ever disagreed,
 *   the server wins, silently, because the client's numbers were never
 *   sent — only the client's authorisation for that is worth having.
 * - It never parses money itself. Every amount-shaped input goes through
 *   sanitizeAmountInput on every keystroke and parseCents for the live
 *   preview, both from src/lib/money.ts — the one parser this project
 *   trusts, after the prototype's `1.234` bug.
 * - It never blocks Save. SPEC.md §5 is deliberately almost no validation:
 *   the live checklist below is shown, not enforced, and only appears once
 *   a save has actually been attempted.
 * - It posts a receipt photo's KEY, never the photo. The file is
 *   compressed in the browser and PUT straight to R2 on a short-lived
 *   signed URL, so no image passes through this app and the R2 credential
 *   stays on the server. A scanned amount only ever fills an EMPTY field:
 *   the person holding the receipt outranks the model.
 */

import React, { useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import {
  CARD_BRACKETS_GROUP_KEY,
  MAX_CARD_BRACKETS,
  cardBracketKey,
  filledCardBrackets,
  removeCardBracket,
  withCardBrackets,
  withoutHiddenBrackets,
} from '../lib/cardMachines';
import Link from 'next/link';
import type { LedgerForm as LedgerFormConfig } from '../lib/forms';
import { flipSign, formatCents, parseCents, sanitizeAmountInput, sanitizeSignedAmountInput } from '../lib/money';
import { AmountInput } from './AmountInput';
import { MAX_CUSTOM_LABEL, MAX_CUSTOM_LINES, normaliseCustomLabel } from '../lib/customLine';
import { computeLedger, linesAgree, slotsAgree } from '../lib/compute';
import {
  MSG_CORRECTION_REASON,
  MSG_DATE,
  MSG_FROM_PHOTO,
  MSG_INVOICE_DATE,
  MSG_INVOICE_NO,
  MSG_MANAGER,
  MSG_DRAFT_NO_PHOTOS,
  MSG_FIELD_AMOUNT,
  MSG_FIELD_DATE,
  MSG_FIELD_INVOICE_NO,
  MSG_FIELD_NAME,
  MSG_PHOTO_AMOUNT_CHECK,
  MSG_PHOTO_UNREAD_PREFIX,
  MSG_PHOTO_UNREAD_SUFFIX,
  MSG_PHOTO_ATTACHED,
  MSG_PHOTO_CHECK_FIRST,
  MSG_HINT_Z_REPORT,
  MSG_HINT_ENVELOPE,
  MSG_PHOTO_CONFIRM_CHECKED,
  MSG_PHOTO_FAILED,
  MSG_PHOTO_LOW_CONFIDENCE,
  MSG_PHOTO_SCANNING,
  MSG_PHOTO_UPLOADING,
  MSG_ITEMS_COUNT,
  MSG_MANAGER_NAME_PLACEHOLDER,
  MSG_SIGNATURE,
  missingHeader,
} from '../lib/messages';
import { saveReportAction } from '../app/actions';
import { useReceiptPhotos } from './useReceiptPhotos';
import ReceiptItems from './ReceiptItems';
import {
  itemsForPayload,
  normaliseItems,
  type ReceiptItemInput,
} from '../lib/receiptItems';
import {
  MSG_SAVE_PHOTO_STILL_UPLOADING,
  PHOTO_WAIT_MS,
  bannerMessages,
  callSave,
  settlesWithin,
  type SaveOutcome,
} from './saveOutcome';
import {
  clearDraft,
  readDraft,
  sameDraftFields,
  defaultBusinessDate,
  todayLocalDateString,
  writeDraft,
  type LedgerDraftFields,
  type StoredLedgerDraft,
} from './ledgerDraft';
import SignaturePad from './SignaturePad';
import styles from './LedgerForm.module.css';

const GREEK_ORDER_LETTERS = ['α', 'β', 'γ', 'δ', 'ε', 'ζ'];
const DRAFT_DEBOUNCE_MS = 500;

interface ExpenseLineState {
  /**
   * The shop, on this form. The paper ledger has ONE free line per expense
   * and people write the supplier on it, so a separate supplier box put
   * the same name on screen twice. It is posted as the supplier too — the
   * ledger sheet simply does not distinguish what was bought from who
   * sold it, and inventing that distinction in the UI did not help anyone.
   */
  description: string;
  amount: string;
  invoiceNumber: string;
  /** YYYY-MM-DD, or ''. */
  invoiceDate: string;
  /** What the receipt lists — read by the scan, then editable. */
  items: ReceiptItemInput[];
}

/** The receipt fields that are plain text, i.e. everything but `items`. */
type ExpenseTextField = 'description' | 'amount' | 'invoiceNumber' | 'invoiceDate';

function blankExpense(): ExpenseLineState {
  return { description: '', amount: '', invoiceNumber: '', invoiceDate: '', items: [] };
}

function sameItems(a: ReceiptItemInput[], b: ReceiptItemInput[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Fills in fields an older record does not have.
 *
 * A draft saved in localStorage before supplier, invoice number and date
 * existed is still sitting in managers' browsers, and a correction loads a
 * night filed before them too. Without this those rows arrive with the
 * fields simply absent, and `e.supplier.trim()` throws on the first
 * render — the form would not open at all.
 */
function normaliseExpense(e: Partial<ExpenseLineState>): ExpenseLineState {
  // `items` goes through its own check rather than the spread: a draft
  // from before items existed has no key, and a damaged one could hold
  // anything — neither may stop the sheet from opening.
  return { ...blankExpense(), ...e, items: normaliseItems(e.items) };
}

/** Which of the four receipt fields are still empty, in the person's words. */
function blankExpenseFields(e: ExpenseLineState | undefined): string[] {
  if (!e) return [];
  const out: string[] = [];
  if (e.description.trim() === '') out.push(MSG_FIELD_NAME);
  if (e.amount.trim() === '') out.push(MSG_FIELD_AMOUNT);
  if (e.invoiceNumber.trim() === '') out.push(MSG_FIELD_INVOICE_NO);
  if (e.invoiceDate.trim() === '') out.push(MSG_FIELD_DATE);
  return out;
}
interface ChequeState {
  amount: string;
  customerName: string;
  customerPhone: string;
  chequeNumber: string;
  bank: string;
}
interface PendingReceiptState {
  amount: string;
  organisationName: string;
  contactPerson: string;
  contactPhone: string;
  receiptNumber: string;
}

function emptyCheque(): ChequeState {
  return { amount: '', customerName: '', customerPhone: '', chequeNumber: '', bank: '' };
}
function emptyPendingReceipt(): PendingReceiptState {
  return { amount: '', organisationName: '', contactPerson: '', contactPhone: '', receiptNumber: '' };
}
function emptyExpenseRows(count: number): ExpenseLineState[] {
  return Array.from({ length: count }, blankExpense);
}

/**
 * A cheque, pending receipt, or expense line the manager added and then
 * left untouched — clicked "+ add", changed their mind, never typed
 * anything. Filtered out of the payload rather than posted as a meaningless
 * empty child row.
 */
function hasAnyValue(entry: object): boolean {
  return Object.values(entry).some((v) => typeof v === 'string' && v.trim() !== '');
}

/** "2026-09-20" -> "20/09/2026"; anything else (blank, malformed) shown as-is. */
function formatBusinessDateForDisplay(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value.trim() || 'χωρίς ημερομηνία';
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/**
 * Where a real receipt-photo upload plugs in later (SPEC.md §9's
 * POST /api/scan, or whatever object-storage endpoint replaces it). Today
 * it does nothing: no network call, nothing written to
 * zet_expense_line.receipt_photo_url, nothing posted by handleSave. The
 * file stays in this component's local, non-drafted state — never in
 * localStorage (File objects aren't JSON-serialisable and nothing here
 * claims the photo is saved anywhere).
 *
 * Kept as one clearly-named, already-async function so wiring up the real
 * upload later is a change in exactly one place, not a search through the
 * component for every spot a photo gets picked.
 */
export interface CorrectionContext {
  /** The night being corrected, as stored. */
  businessDate: string;
  /** The values as filed, so a correction starts from them, not a blank sheet. */
  initial: LedgerDraftFields;
  /**
   * Which revision this will become. Shown so nobody thinks they are filing
   * fresh. null when the night is not approved yet: then it is simply
   * edited, with no revision and no reason.
   */
  nextRevisionNo: number | null;
}

/** A named extra line on a ledger sheet: the label is the identity. */
interface CustomLineState {
  label: string;
  amount: string;
}

function customLineTouched(l: CustomLineState): boolean {
  return l.label.trim() !== '' || l.amount.trim() !== '';
}

/**
 * Exactly one blank line waiting at the end, however the list got here.
 * Only ever ADDS the spare, and only while there is room — slicing an
 * oversized list instead would drop a filled line off the end, and
 * losing money off a till sheet to tidy a list is never the trade.
 */
function withOneSpareLine(list: CustomLineState[]): CustomLineState[] {
  const next = list.map((l) => ({ label: l.label, amount: l.amount }));
  while (
    next.length > 1 &&
    !customLineTouched(next[next.length - 1]!) &&
    !customLineTouched(next[next.length - 2]!)
  ) {
    next.pop();
  }
  if (next.length < MAX_CUSTOM_LINES && (next.length === 0 || customLineTouched(next[next.length - 1]!))) {
    next.push({ label: '', amount: '' });
  }
  return next;
}

export default function LedgerFormSheet({
  form: baseForm,
  correction,
}: {
  form: LedgerFormConfig;
  /**
   * Present when reopening a night that was already filed. The sheet
   * starts filled in. When the night is approved (nextRevisionNo set) it is
   * a correction: a reason becomes required, and the payload carries
   * correctionReason — which the DATABASE, not this component, insists on
   * (migration 0003). Otherwise it is an edit and simply saves over it.
   */
  correction?: CorrectionContext;
}) {
  const uid = useId();

  const seed = correction?.initial;
  // An approved night being corrected (revision, reason) — as opposed to an
  // unapproved one simply being edited, which saves over itself.
  const isCorrection = correction !== undefined && correction.nextRevisionNo !== null;

  const [businessDate, setBusinessDate] = useState(
    seed?.businessDate ?? defaultBusinessDate()
  );
  const [closingManagerName, setClosingManagerName] = useState(seed?.closingManagerName ?? '');
  const [signature, setSignature] = useState('');
  const [values, setValues] = useState<Record<string, string>>(seed?.values ?? {});

  /**
   * Card brackets: SIX CARDS split into numbered boxes, one per machine,
   * as many as the manager adds tonight (src/lib/cardMachines.ts). The
   * sheet is the config with that many brackets; the server rebuilds the
   * same sheet from the keys posted.
   */
  const [cardCount, setCardCount] = useState(() => filledCardBrackets(seed?.values ?? {}));
  const form = useMemo(() => withCardBrackets(baseForm, cardCount), [baseForm, cardCount]);

  function addCardBracket() {
    if (cardCount >= MAX_CARD_BRACKETS || !baseForm.cardRowKey) return;
    const cardKey = baseForm.cardRowKey;
    // The first bracket takes over whatever was already typed in SIX
    // CARDS, so splitting never leaves the same money in two boxes.
    if (cardCount === 0) {
      setValues((prev) =>
        (prev[cardKey] ?? '').trim() === ''
          ? prev
          : { ...prev, [cardBracketKey(1)]: prev[cardKey]!, [cardKey]: '' }
      );
    }
    setCardCount(cardCount + 1);
  }

  function removeBracket(n: number) {
    setValues((prev) => removeCardBracket(prev, cardCount, n));
    setCardCount(cardCount - 1);
  }

  const cardBracketAdder =
    baseForm.cardRowKey && cardCount < MAX_CARD_BRACKETS ? (
      <div className={styles.rowGroup}>
        <div className={styles.slotsCell} />
        <div className={styles.labelCell} data-align={baseForm.labelAlign}>
          <button type="button" className={styles.addButton} onClick={addCardBracket}>
            + μηχάνημα καρτών
          </button>
        </div>
        <div className={styles.signCell} />
        <div className={styles.amountCell} />
      </div>
    ) : null;
  const [labels, setLabels] = useState<Record<string, string>>(seed?.labels ?? {});

  /**
   * Named extra lines — the printed write-in row continued into a list.
   * One blank row always waits at the end, the same way the shifts sheet
   * and the invoice list behave, so adding a line is just typing in it.
   */
  const [customLines, setCustomLines] = useState<CustomLineState[]>(() =>
    withOneSpareLine(seed?.customLines ?? [])
  );

  function setCustomLabel(i: number, raw: string): void {
    setCustomLines((prev) =>
      withOneSpareLine(
        prev.map((l, n) => (n === i ? { ...l, label: raw.replace(/\s+/g, ' ') } : l))
      )
    );
  }
  function setCustomAmount(i: number, raw: string): void {
    setCustomLines((prev) =>
      withOneSpareLine(
        prev.map((l, n) => (n === i ? { ...l, amount: sanitizeAmountInput(raw) } : l))
      )
    );
  }
  const [slots, setSlots] = useState<Record<string, string[]>>(seed?.slots ?? {});
  const [correctionReason, setCorrectionReason] = useState('');
  const [expenses, setExpenses] = useState<ExpenseLineState[]>(() =>
    seed && seed.expenses.length > 0
      ? [
          ...seed.expenses.map(normaliseExpense),
          ...emptyExpenseRows(Math.max(0, form.expenseRowCount - seed.expenses.length)),
        ]
      : emptyExpenseRows(form.expenseRowCount)
  );
  const [cheques, setCheques] = useState<ChequeState[]>(seed?.cheques ?? []);
  const [pendingReceipts, setPendingReceipts] = useState<PendingReceiptState[]>(
    seed?.pendingReceipts ?? []
  );
  const [counted, setCounted] = useState(seed?.counted ?? '');

  /**
   * The expense rows as last committed, readable after an await.
   *
   * A scan lands some seconds after the photo was chosen, and it must not
   * overwrite anything typed in the meantime. Reading state through a
   * closure created before the upload would show the row as it was BEFORE
   * the person typed; this ref shows it as it is.
   */
  const expensesRef = useRef(expenses);
  expensesRef.current = expenses;

  /** Exactly what the scan wrote into each row, so removal can undo it. */
  const scanWrote = useRef<Record<number, Partial<ExpenseLineState>>>({});

  // Never drafted: a draft is JSON in localStorage and a photo is not.
  // The KEY is posted with the report; the file itself goes straight to R2.
  /** The hook, reachable from inside its own options — see the note on
   *  the same ref in ShiftsForm. */
  const photosRef = useRef<ReturnType<typeof useReceiptPhotos> | null>(null);

  const photos = useReceiptPhotos({
    restaurantId: form.id,
    businessDate,
    blankFields: (slot) => blankExpenseFields(expensesRef.current[Number(slot)]),
    /**
     * One page per expense row, from the row that was clicked downwards.
     * This sheet prints a fixed number of rows, so unlike the shifts
     * sheet it cannot grow: a PDF with more pages than there are rows
     * left gets as many as fit, and the hook says so on screen rather
     * than dropping the rest quietly.
     */
    slotsForPages: (firstSlot, pageCount) => {
      const start = Number(firstSlot);
      if (!Number.isFinite(start)) return [firstSlot];

      // EMPTY rows only, after the clicked one. Taking the next N-1 by
      // position overwrote rows that already held expenses somebody had
      // typed in, without asking. The clicked row itself is fair game:
      // that is a person deliberately replacing what is on it.
      const list = expensesRef.current;
      const taken = (i: number) => {
        const e = list[i];
        if (!e) return false;
        return (
          hasAnyValue(e) ||
          e.items.length > 0 ||
          (photosRef.current?.keyFor(String(i)) ?? '') !== ''
        );
      };

      const chosen = [String(start)];
      for (let i = start + 1; i < list.length && chosen.length < pageCount; i += 1) {
        if (!taken(i)) chosen.push(String(i));
      }
      // This sheet prints a fixed number of expense rows, so unlike the
      // shifts sheet it cannot grow. Short is reported on screen by the
      // hook rather than swallowed.
      return chosen;
    },
    onRemoved: (slot) => {
      const index = Number(slot);
      const written = scanWrote.current[index];
      delete scanWrote.current[index];
      if (!written) return;
      // Clears a field ONLY if it still holds exactly what the scan put
      // there. Anything corrected by hand since is the person's own work
      // and survives — removing a photo must not quietly undo typing.
      setExpenses((prev) =>
        prev.map((e, i) => {
          if (i !== index) return e;
          const next = { ...e };
          for (const k of ['description', 'amount', 'invoiceNumber', 'invoiceDate'] as const) {
            if (written[k] !== undefined && next[k] === written[k]) next[k] = '';
          }
          // The same rule for the item list: gone only if nobody has
          // touched it since the scan wrote it.
          if (written.items && sameItems(next.items, written.items)) next.items = [];
          return next;
        })
      );
    },
    onScanned: (slot, scan) => {
      const index = Number(slot);
      const row = expensesRef.current[index];
      if (!row) return;

      // Only ever fills a BLANK field. The person standing there with the
      // receipt outranks the model, and a scanned figure that quietly
      // replaced a typed one would be the worst kind of wrong:
      // authoritative-looking and never re-read.
      const patch: Partial<ExpenseLineState> = {};
      const fields: string[] = [];

      if (row.amount.trim() === '' && scan.totalCents != null) {
        patch.amount = formatCents(scan.totalCents);
        fields.push(formatCents(scan.totalCents));
      }
      if (row.description.trim() === '' && scan.supplier) {
        patch.description = scan.supplier;
        fields.push(scan.supplier);
      }
      if (row.invoiceNumber.trim() === '' && scan.invoiceNumber) {
        patch.invoiceNumber = scan.invoiceNumber;
        fields.push(scan.invoiceNumber);
      }
      if (row.invoiceDate.trim() === '' && scan.date) {
        patch.invoiceDate = scan.date;
        fields.push(scan.date);
      }
      // Items follow the same rule as every other field: only into an
      // empty list. Someone who has started typing the items themselves
      // keeps what they typed.
      const scannedItems = scan.items ?? [];
      if (row.items.length === 0 && scannedItems.length > 0) {
        patch.items = scannedItems.map((it) => ({
          name: it.name,
          qty: it.qty,
          // A price the scan could not read stays EMPTY, not 0,00: an
          // empty box asks to be filled in, a zero looks like an answer.
          amount: it.amountCents == null ? '' : formatCents(it.amountCents),
        }));
        fields.push(MSG_ITEMS_COUNT(patch.items.length));
      }

      if (Object.keys(patch).length > 0) {
        scanWrote.current[index] = patch;
        setExpenses((prev) => prev.map((e, i) => (i === index ? { ...e, ...patch } : e)));
      }
      // Named after the fields the person sees, so the notice below reads
      // as instructions rather than as a list of internal keys.
      const after = { ...row, ...patch };
      const unread = blankExpenseFields(after);

      const hint =
        patch.amount !== undefined
          ? scan.totalLabel
            ? `«${scan.totalLabel}» → ${patch.amount}`
            : patch.amount
          : undefined;
      return { amount: patch.amount !== undefined, fields, hint, unread };
    },
  });
  photosRef.current = photos;

  const [hasAttemptedSave, setHasAttemptedSave] = useState(false);
  const [result, setResult] = useState<SaveOutcome | null>(null);
  // A Server Action is, by this Next.js version's own convention, an async
  // function invoked inside startTransition — that wrapping happens for
  // free when it's passed to a <form action> or <button formAction>, but
  // this form's state is far richer than FormData, so the call is made
  // directly here and startTransition is applied by hand instead. `saving`
  // below is deliberately this hook's own isPending, not separate state.
  const [saving, startSaveTransition] = useTransition();

  // ── Drafts (NEXT_STEP step 4, item 3) ────────────────────────────────
  //
  // The dirty check compares live state against `baselineRef`, never
  // against a hardcoded blank — "if the date defaults to today, that alone
  // is not dirty" only holds if the comparison point moves when a draft is
  // restored. It starts at the true blank state and is reassigned exactly
  // twice: when a draft is applied (silently or by choice), and right after
  // a successful save (the just-saved state becomes the new "clean" point).
  const baselineRef = useRef<LedgerDraftFields>(buildFields());
  // A draft whose business date is NOT today: shown as a choice, never
  // applied until the manager picks "continue". null once resolved either
  // way, and while there is simply no such draft.
  const [draftChoice, setDraftChoice] = useState<StoredLedgerDraft | null>(null);

  function buildFields(): LedgerDraftFields {
    return {
      businessDate,
      closingManagerName,
      signature,
      values,
      labels,
      slots,
      customLines,
      expenses,
      cheques,
      pendingReceipts,
      counted,
    };
  }

  function applyDraftFields(draft: LedgerDraftFields) {
    setBusinessDate(draft.businessDate);
    setClosingManagerName(draft.closingManagerName);
    setSignature(draft.signature);
    setValues(draft.values);
    setCardCount(filledCardBrackets(draft.values));
    setLabels(draft.labels);
    setSlots(draft.slots);
    setCustomLines(withOneSpareLine(draft.customLines ?? []));
    setExpenses(
      draft.expenses.length > 0
        ? draft.expenses.map(normaliseExpense)
        : emptyExpenseRows(form.expenseRowCount)
    );
    setCheques(draft.cheques);
    setPendingReceipts(draft.pendingReceipts);
    setCounted(draft.counted);
    baselineRef.current = draft;
  }

  const fields = useMemo(
    () => buildFields(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [businessDate, closingManagerName, signature, values, labels, slots, customLines, expenses, cheques, pendingReceipts, counted]
  );
  const isDirty = useMemo(() => !sameDraftFields(fields, baselineRef.current), [fields]);

  // Read once on mount. Today's date -> restore silently (the "back two
  // minutes later" case). Any other date -> ask, never load it under
  // today's date without saying so — SPEC's whole point about a wrong
  // number getting signed.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // A correction never restores a draft. The draft belongs to whatever
    // night someone was filing; applying it here would quietly replace the
    // figures being corrected with unrelated ones.
    if (correction) return;
    const draft = readDraft(window.localStorage, form.id);
    if (!draft) return;
    // Always ask, even for today's date.
    //
    // A draft cannot carry the receipt PHOTOS — they are in R2 under keys
    // held in memory, and a reload loses them. Restoring silently therefore
    // produced a sheet that looked complete, with amounts and supplier
    // names read off receipts whose photos were no longer attached to
    // anything. Filing that is worse than filing nothing.
    setDraftChoice(draft);
    // Mount only — this must not re-run as the manager types.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.id]);

  // Debounced write while typing. Never fires for untouched/blank state —
  // there is nothing worth saving, and no draft should appear from a mere
  // mis-tap that never got edited.
  useEffect(() => {
    if (correction) return; // see the restore effect above
    if (!isDirty) return;
    if (typeof window === 'undefined') return;
    const timer = window.setTimeout(() => {
      writeDraft(window.localStorage, form.id, fields);
    }, DRAFT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [fields, isDirty, form.id]);

  // Tab-close and refresh — the back link below can't cover those.
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (!isDirty) return;
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  // The back link itself: flush synchronously if dirty, so the write can't
  // race the debounce timer being torn down by navigation. Nothing typed
  // -> nothing happens here at all: no prompt, no draft, nothing left
  // behind that wasn't already there.
  function handleBackClick() {
    if (typeof window === 'undefined') return;
    if (isDirty) {
      writeDraft(window.localStorage, form.id, fields);
    }
  }

  /**
   * Rows whose total this form worked out from the α)…ε) boxes, as
   * opposed to rows somebody wrote a figure into.
   *
   * The difference decides whether the breakdown may overwrite the row.
   * Managers mostly write only the total; when they write BOTH, the two
   * were arrived at separately and a disagreement between them is the
   * thing worth seeing — so filling the row in from the slots would
   * erase the very signal the slots_disagree flag exists to catch.
   */
  const derivedRows = useRef<Set<string>>(new Set());

  function setValue(key: string, raw: string) {
    // Typed into by hand: from here on this row is theirs, not ours.
    derivedRows.current.delete(key);
    setValues((prev) => ({ ...prev, [key]: sanitizeAmountInput(raw) }));
  }
  function setLabel(key: string, raw: string) {
    setLabels((prev) => ({ ...prev, [key]: raw }));
  }
  function setSlot(key: string, index: number, raw: string) {
    setSlots((prev) => {
      const current = prev[key] ?? [];
      // Built with a fill, not a bare index assignment: typing directly
      // into γ) before α)/β) would otherwise leave those earlier indices as
      // true array holes rather than empty strings. The payload's slots
      // field is z.array(z.string()) — a hole can serialise as `undefined`,
      // which fails that schema and turns an ordinary save into an opaque
      // "something went wrong" instead of the normal, allowed case of an
      // itemised slot filled out of order.
      const next = Array.from({ length: Math.max(current.length, index + 1) }, (_, i) => current[i] ?? '');
      next[index] = sanitizeAmountInput(raw);

      // The breakdown fills the row in as it is typed — but only a row
      // nobody has written in. A total already on the sheet was arrived
      // at separately, and overwriting it with the sum would hide the
      // disagreement instead of showing it.
      //
      // Clearing the LAST slot empties the row again, and only a row we
      // filled. Skipping that update entirely left whatever was last
      // worked out sitting in the box: erasing "10,00" passes through
      // "1" on the way out, so the row was left reading 1,00 — a figure
      // that looks entered, reconciles like one, and nobody typed.
      const anyFilled = next.some((v) => v.trim() !== '');
      const sum = next.reduce((a, v) => a + parseCents(v), 0);
      setValues((vals) => {
        const written = (vals[key] ?? '').trim();
        const ours = derivedRows.current.has(key);
        if (written !== '' && !ours) return vals;
        if (anyFilled) {
          derivedRows.current.add(key);
          return { ...vals, [key]: formatCents(sum) };
        }
        derivedRows.current.delete(key);
        return { ...vals, [key]: '' };
      });

      return { ...prev, [key]: next };
    });
  }

  /** Was this row's figure worked out here, rather than written in? */
  function hasBreakdown(key: string): boolean {
    return derivedRows.current.has(key);
  }
  function setExpenseField(index: number, field: ExpenseTextField, raw: string) {
    const value = field === 'amount' ? sanitizeAmountInput(raw) : raw;
    setExpenses((prev) => prev.map((e, i) => (i === index ? { ...e, [field]: value } : e)));
  }
  function setExpenseItems(index: number, items: ReceiptItemInput[]) {
    setExpenses((prev) => prev.map((e, i) => (i === index ? { ...e, items } : e)));
  }
  function addCheque() {
    setCheques((prev) => [...prev, emptyCheque()]);
  }
  function removeCheque(index: number) {
    setCheques((prev) => prev.filter((_, i) => i !== index));
  }
  function setChequeField(index: number, field: keyof ChequeState, raw: string) {
    const value = field === 'amount' ? sanitizeAmountInput(raw) : raw;
    setCheques((prev) => prev.map((c, i) => (i === index ? { ...c, [field]: value } : c)));
  }
  function addPendingReceipt() {
    setPendingReceipts((prev) => [...prev, emptyPendingReceipt()]);
  }
  function removePendingReceipt(index: number) {
    setPendingReceipts((prev) => prev.filter((_, i) => i !== index));
  }
  function setPendingField(index: number, field: keyof PendingReceiptState, raw: string) {
    const value = field === 'amount' ? sanitizeAmountInput(raw) : raw;
    setPendingReceipts((prev) => prev.map((p, i) => (i === index ? { ...p, [field]: value } : p)));
  }
  // SPEC.md §3: "Add a row automatically when the last one is used." Once
  // the last printed expense row has anything in it, a new blank one
  // appears — the array only ever grows, matching the paper never running
  // out of lines to write on.
  useEffect(() => {
    const last = expenses[expenses.length - 1];
    if (last && hasAnyValue(last)) {
      setExpenses((prev) => [...prev, blankExpense()]);
    }
  }, [expenses]);

  // ── Live, read-only arithmetic — "the arithmetic is done for them".
  // Recomputed on every keystroke, never posted. src/server/saveReport.ts
  // does the same computation independently, from the raw strings below,
  // and that copy — not this one — is what ends up in the database.
  const totals = useMemo(() => {
    const valuesCents = Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, parseCents(v)])
    );
    const slotsCents = Object.fromEntries(
      Object.entries(slots).map(([k, arr]) => [k, arr.map((s) => parseCents(s))])
    );
    return computeLedger(form, {
      values: valuesCents,
      // Unnamed lines are not lines. Someone who typed a figure and no
      // name has not finished, and the server refuses that line for the
      // same reason — a preview that disagrees with the save is worse
      // than either on its own.
      customLines: customLines
        .filter((l) => normaliseCustomLabel(l.label) !== '')
        .map((l) => ({ label: normaliseCustomLabel(l.label), cents: parseCents(l.amount) })),
      slots: slotsCents,
      expenses: expenses.map((e) => ({ description: e.description, cents: parseCents(e.amount) })),
      countedCents: parseCents(counted),
    });
  }, [form, values, slots, expenses, counted, customLines]);

  // SPEC.md §5's three required things, checked here purely so the live
  // checklist can update as the manager types, without a round trip. The
  // server's own copy of this check (src/server/saveReport.ts) is what
  // actually decides whether a save is accepted — this one is UX only.
  const localMissing = useMemo(() => {
    const missing: string[] = [];
    if (!businessDate.trim()) missing.push(MSG_DATE);
    if (!closingManagerName.trim()) missing.push(MSG_MANAGER);
    if (!signature.trim()) missing.push(MSG_SIGNATURE);
    if (isCorrection && !correctionReason.trim()) missing.push(MSG_CORRECTION_REASON);
    return missing;
  }, [businessDate, closingManagerName, signature, isCorrection, correctionReason]);

  async function handleSave() {
    setHasAttemptedSave(true);

    // Inside the transition from the first await, so the button reads
    // «Αποθήκευση…» while photos finish uploading. Before, it sat unchanged
    // for as long as an upload hung — a button that looks like it does
    // nothing. The wait completes work already started, so the payload
    // carries the photo keys rather than losing them; it is capped, and
    // giving up says so (src/components/saveOutcome.ts).
    startSaveTransition(async () => {
      setResult(null);
      if (!(await settlesWithin(photos.awaitPending(), PHOTO_WAIT_MS))) {
        setResult({ ok: false, error: 'photo_still_uploading', messages: [MSG_SAVE_PHOTO_STILL_UPLOADING] });
        return;
      }

      // Only after the uploads settle, because a scan finishing is what
      // raises the question in the first place.
      if (photos.pendingChecks().length > 0) {
        setResult({
          ok: false,
          error: 'missing_fields',
          messages: [MSG_PHOTO_CHECK_FIRST],
          header: missingHeader(1),
        });
        return;
      }

      // Captured once, now — not re-read after the response arrives, which
      // could otherwise be a keystroke or two further along if the manager
      // keeps typing while the request is in flight.
      const savedFields = fields;

      // Exactly the shape src/server/saveReport.ts's SaveReportInputSchema
      // expects. Every amount is the string as typed — never parsed into
      // cents here. That parsing, and the totals it produces, belongs to the
      // server alone (CLAUDE.md rule 2).
      const payload = {
        restaurantId: form.id,
        businessDate: savedFields.businessDate,
        closingManagerName: savedFields.closingManagerName,
        signature: savedFields.signature,
        ...(isCorrection ? { correctionReason: correctionReason.trim() } : {}),
        ledger: {
          // Only the brackets on screen: a figure left under one that was
          // removed is not money anyone can see, so it is not sent.
          values: withoutHiddenBrackets(savedFields.values, cardCount),
          labels: savedFields.labels,
          // Trimmed to what the sheet now prints. A night filed when B3 had
          // six slots still has six stored; posting all six at a row that
          // now prints five is refused outright, which would have blocked
          // a manager from correcting an unrelated figure on that night.
          // The dropped box is already invisible on screen, and the row's
          // breakdown will report itself as not summing until someone
          // re-enters it — which is the visible version of this, and the
          // one worth having.
          slots: Object.fromEntries(
            Object.entries(savedFields.slots).map(([key, list]) => {
              const row = form.rows.find((r) => r.key === key);
              const max = row && row.kind === 'input' ? (row.slots ?? 0) : 0;
              return [key, list.slice(0, max)];
            })
          ),
          // Only lines somebody touched. The sheet always carries a spare
          // blank one; sending it would be sending a row that is not there.
          customLines: (savedFields.customLines ?? [])
            .filter((l) => l.label.trim() !== '' || l.amount.trim() !== '')
            .map((l) => ({ label: l.label.trim(), amount: l.amount })),
          expenses: savedFields.expenses
            // From the hook's ref, not from state: this runs after an await,
            // where a render-captured value would be stale.
            .map((e, i) => ({
              ...e,
              // The ledger's one free line is the supplier line — see
              // ExpenseLineState. Posting it under both names keeps the
              // invoicing join populated without a second box on screen.
              supplier: e.description,
              receiptPhotoUrl: photos.keyFor(String(i)),
              // Touched lines only, as strings: the server parses amounts.
              items: itemsForPayload(e.items ?? []),
            }))
            // Items alone make a line real too — someone can type what was
            // bought before the amount.
            .filter((e) => hasAnyValue(e) || e.receiptPhotoUrl !== '' || e.items.length > 0),
          cheques: savedFields.cheques.filter(hasAnyValue),
          pendingReceipts: savedFields.pendingReceipts.filter(hasAnyValue),
          counted: savedFields.counted,
        },
      };

      const response = await callSave(saveReportAction, payload);
      setResult(response);
      // The server never saw it: keep the sheet on this device, so a
      // reload to get a fresh page does not lose the night.
      if (
        !response.ok &&
        !correction &&
        (response.error === 'offline' || response.error === 'no_response') &&
        typeof window !== 'undefined'
      ) {
        writeDraft(window.localStorage, form.id, savedFields);
      }
      if (response.ok && typeof window !== 'undefined') {
        clearDraft(window.localStorage, form.id);
        baselineRef.current = savedFields;
      }
    });
  }

  // The live checklist already shows the date / manager / signature lines
  // as the manager types, so those are not repeated here. Every OTHER line
  // is — the receipt check, a not-authorised, a lost connection — because
  // this banner is the only place it can appear. Hiding the whole
  // 'missing_fields' result once made Save look dead (saveOutcome.ts).
  const serverMessages = bannerMessages(result, hasAttemptedSave ? localMissing : []);

  return (
    <div className={styles.page}>
      {/* Outside the <form> entirely — a plain navigation link can never
          submit it, but keeping it structurally separate is what makes
          that true by construction rather than by care. */}
      {correction && correction.nextRevisionNo !== null && (
        <div className={styles.correctionBanner}>
          <p className={styles.correctionTitle}>
            Διόρθωση κλεισίματος {correction.businessDate}
          </p>
          <p>
            Θα γίνει αναθεώρηση {correction.nextRevisionNo}. Το προηγούμενο κλείσιμο
            κρατιέται όπως είναι — δεν σβήνεται.
          </p>
        </div>
      )}
      {correction && correction.nextRevisionNo === null && (
        <div className={styles.correctionBanner}>
          <p className={styles.correctionTitle}>
            Επεξεργασία κλεισίματος {correction.businessDate}
          </p>
          <p>Δεν έχει εγκριθεί ακόμα, οπότε η αποθήκευση γράφει πάνω του.</p>
        </div>
      )}

      <Link href="/" className={styles.backLink} onClick={handleBackClick}>
        ← Εστιατόρια
      </Link>

      {draftChoice && (
        <div className={styles.draftChoice} role="group" aria-label="Επαναφορά αποθηκευμένου φύλλου">
          <p>
            Βρέθηκε αποθηκευμένο φύλλο για {formatBusinessDateForDisplay(draftChoice.businessDate)}.
            Θέλετε να το συνεχίσετε ή να ξεκινήσετε νέο;
          </p>
          <p className={styles.draftChoiceWarning}>{MSG_DRAFT_NO_PHOTOS}</p>
          <div className={styles.draftChoiceButtons}>
            <button
              type="button"
              onClick={() => {
                applyDraftFields(draftChoice);
                setDraftChoice(null);
              }}
            >
              Συνέχιση — {formatBusinessDateForDisplay(draftChoice.businessDate)}
            </button>
            <button
              type="button"
              onClick={() => {
                if (typeof window !== 'undefined') clearDraft(window.localStorage, form.id);
                setDraftChoice(null);
              }}
            >
              Νέο φύλλο
            </button>
          </div>
        </div>
      )}

      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
      >
        <header className={styles.letterhead}>
          <p className={styles.legalName}>{form.legalName}</p>
          {form.tagline && <p className={styles.tagline}>{form.tagline}</p>}
          {form.branch && <p className={styles.branch}>{form.branch}</p>}
          <p className={styles.address}>{form.address}</p>
          {form.phone && <p className={styles.phone}>τηλ {form.phone}</p>}
          <p className={styles.formRef}>
            {form.formRef}
            {form.pageNumber ? ` · σελ. ${form.pageNumber}` : ''}
          </p>
        </header>

        <div className={styles.metaGrid}>
          <div className={styles.field}>
            <label htmlFor={`${uid}-date`}>Ημερομηνία</label>
            <input
              id={`${uid}-date`}
              type="date"
              value={businessDate}
              onChange={(e) => setBusinessDate(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor={`${uid}-manager`}>Έκλεισε το ταμείο</label>
            <input
              id={`${uid}-manager`}
              type="text"
              value={closingManagerName}
              onChange={(e) => setClosingManagerName(e.target.value)}
              autoComplete="name"
              placeholder={MSG_MANAGER_NAME_PLACEHOLDER}
            />
          </div>
        </div>

        <div className={styles.rows}>
          {form.rows.map((row) => {
            if (row.kind === 'expenses') return null;

            // A retired row is hidden on a fresh sheet and shown on a night
            // that carries a figure under it. That is the whole point of
            // retiring rather than deleting: the sheet gets clean without
            // last year's books losing a line they were balanced with.
            //
            // It cannot return early, because the write-in row it hides is
            // also the row the named lines hang off — returning here took
            // the whole list off the sheet with it.
            let hidden = false;
            if ((row.kind === 'input' || row.kind === 'group') && row.retired) {
              const carries =
                row.kind === 'group'
                  ? row.children.some((c) => (values[c.key] ?? '').trim() !== '')
                  // A label counts as carrying: the write-in row was named
                  // by hand, and hiding a night's "Kiosk" because the
                  // figure beside it was zero would lose what it said.
                  : (values[row.key] ?? '').trim() !== '' ||
                    (labels[row.key] ?? '').trim() !== '';
              hidden = !carries;
              if (hidden && form.customLinesAfter !== row.key) return null;
            }

            if (row.kind === 'subtotal') {
              const amountCents = totals.subtotals[row.key] ?? 0;
              return (
                <div className={styles.rowGroup} key={row.key}>
                  <div className={styles.slotsCell} />
                  <div className={styles.labelCell} data-align={form.labelAlign}>
                    <span className={styles.labelText}>{row.label}</span>
                  </div>
                  <div className={styles.signCell}>=</div>
                  <div className={styles.amountCell}>
                    <span className={styles.amountReadOnly}>{formatCents(amountCents)}</span>
                  </div>
                </div>
              );
            }

            if (row.kind === 'group') {
              // The total is READ-ONLY and is the sum of its parts. It is
              // also the only figure that gets deducted — see computeLedger.
              // Making it typable would let it disagree with its own parts,
              // and then two boxes on one sheet would claim to be Foody.
              const partCents = row.children.map((c) => parseCents(values[c.key] ?? ''));
              const groupCents = partCents.reduce((a, b) => a + b, 0);
              return (
                <React.Fragment key={row.key}>
                  <div className={styles.rowGroup}>
                    <div className={styles.slotsCell} />
                    <div className={styles.labelCell} data-align={form.labelAlign}>
                      <span className={styles.labelText}>{row.label}</span>
                    </div>
                    <div className={styles.signCell}>{row.sign ?? ''}</div>
                    <div className={styles.amountCell}>
                      <span className={styles.amountReadOnly}>{formatCents(groupCents)}</span>
                    </div>
                  </div>
                  {row.children
                    // A retired part shows only on a night that has a
                    // figure under it, like a retired row.
                    .filter((child) => !child.retired || (values[child.key] ?? '').trim() !== '')
                    .map((child, ci) => (
                    <div className={`${styles.rowGroup} ${styles.groupChild}`} key={child.key}>
                      <div className={styles.slotsCell} />
                      <div className={styles.labelCell} data-align={form.labelAlign}>
                        {/* Remove sits by the number, away from the amount
                            box a thumb is aiming at. */}
                        {row.key === CARD_BRACKETS_GROUP_KEY && (
                          <button
                            type="button"
                            className={styles.bracketRemove}
                            onClick={() => removeBracket(ci + 1)}
                            aria-label={`Αφαίρεση ${row.label} ${child.label}`}
                          >
                            ×
                          </button>
                        )}
                        <span className={styles.labelText}>{child.label}</span>
                      </div>
                      <div className={styles.signCell} />
                      <div className={styles.amountCell}>
                        <AmountInput
                          className={styles.amountInput}
                          value={values[child.key] ?? ''}
                          onValue={(v) => setValue(child.key, v)}
                          aria-label={`${row.label} — ${child.label}`}
                        />
                      </div>
                    </div>
                  ))}
                  {row.key === CARD_BRACKETS_GROUP_KEY && cardBracketAdder}
                </React.Fragment>
              );
            }

            // row.kind === 'input'
            const rowValue = values[row.key] ?? '';
            const rowCents = parseCents(rowValue);
            const rowSlots = slots[row.key] ?? [];
            const rowHasBreakdown = hasBreakdown(row.key);
            const slotsOk = row.slots ? slotsAgree(rowSlots.map(parseCents), rowCents) : true;

            const emphasisClass = row.emphasis === 'large' ? styles.emphasisLarge : '';

            const showItemised = row.items === 'cheques' || row.items === 'pending';
            const itemLines = row.items === 'cheques' ? cheques : row.items === 'pending' ? pendingReceipts : [];
            const linesOk = showItemised
              ? linesAgree(itemLines.map((l) => ({ cents: parseCents(l.amount) })), rowCents)
              : true;

            // Named lines are rendered as REAL rows in the same grid, not
            // inside the row's detail cell: the detail cell has its own
            // column geometry, so a line laid out there sits at a
            // different indent and box width from every printed row it
            // is supposed to read as one of.
            const printedRow = (
              <div className={`${styles.rowGroup} ${emphasisClass}`}>
                <div className={styles.slotsCell}>
                  {row.slots
                    ? Array.from({ length: row.slots }, (_, i) => (
                        <span key={i} className={styles.slotGroup}>
                          <span className={styles.slotLetter}>{GREEK_ORDER_LETTERS[i]})</span>
                          <AmountInput
                            className={styles.slotInput}
                            value={rowSlots[i] ?? ''}
                            onValue={(v) => setSlot(row.key, i, v)}
                            aria-label={`${row.label || 'γραμμή'} — παραγγελία ${GREEK_ORDER_LETTERS[i]}`}
                          />
                        </span>
                      ))
                    : null}
                </div>

                <div className={styles.labelCell} data-align={form.labelAlign}>
                  {row.editableLabel ? (
                    // Placeholder was "π.χ. Kiosk". Engomi now has a real
                    // VISA KIOSK row, so offering Kiosk as the example here
                    // points at a row that already exists, and invites the
                    // same takings being entered on both lines.
                    <input
                      className={styles.editableLabelInput}
                      type="text"
                      value={labels[row.key] ?? ''}
                      onChange={(e) => setLabel(row.key, e.target.value)}
                      placeholder="+ όνομα"
                      aria-label="Ονομασία γραμμής"
                    />
                  ) : (
                    <span className={styles.labelText}>{row.label}</span>
                  )}
                  {row.prefix && <span className={styles.labelPrefix}>{row.prefix}</span>}
                </div>

                <div className={styles.signCell}>{row.sign ?? ''}</div>

                <div className={styles.amountCell}>
                  <AmountInput
                    className={styles.amountInput}
                    value={rowValue}
                    onValue={(v) => setValue(row.key, v)}
                    // Filled in from the α)…ε) boxes as they are typed, but
                    // never locked. A row whose breakdown does not add up
                    // is a real thing this sheet is meant to SHOW — and a
                    // locked box would leave the person looking at a
                    // mismatch warning with no way to answer it.
                    data-derived={rowHasBreakdown ? '' : undefined}
                    placeholder={row.source === 'z_report' ? MSG_HINT_Z_REPORT : undefined}
                    aria-label={row.editableLabel ? 'Ποσό γραμμής' : row.label}
                  />
                </div>

                {row.slots && !slotsOk && (
                  <div className={styles.detailCell}>
                    <p className={styles.mismatchHint}>
                      Τα επιμέρους ποσά δεν αθροίζουν στο ποσό της γραμμής.
                    </p>
                  </div>
                )}

                {row.note && (
                  <div className={styles.detailCell}>
                    <p className={styles.note}>{row.note}</p>
                  </div>
                )}

              </div>
            );

            if (!(form.allowCustomLines && form.customLinesAfter === row.key)) {
              return (
                <React.Fragment key={row.key}>
                  {printedRow}
                  {/* SIX CARDS with no brackets yet: the way to add the first. */}
                  {row.key === form.cardRowKey && cardCount === 0 && cardBracketAdder}
                </React.Fragment>
              );
            }

            return (
              <React.Fragment key={row.key}>
                {!hidden && printedRow}
                {customLines.map((line, li) => (
                  <div className={styles.rowGroup} key={`custom-${li}`}>
                    <div className={styles.slotsCell} />
                    <div className={styles.labelCell} data-align={form.labelAlign}>
                      <input
                        className={styles.editableLabelInput}
                        type="text"
                        value={line.label}
                        maxLength={MAX_CUSTOM_LABEL}
                        placeholder="+ όνομα"
                        aria-label={`Ονομασία γραμμής ${li + 1}`}
                        onChange={(e) => setCustomLabel(li, e.target.value)}
                      />
                    </div>
                    <div className={styles.signCell}>−</div>
                    <div className={styles.amountCell}>
                      <AmountInput
                        className={styles.amountInput}
                        value={line.amount}
                        aria-label={line.label.trim() || `Ποσό γραμμής ${li + 1}`}
                        onValue={(v) => setCustomAmount(li, v)}
                      />
                    </div>
                  </div>
                ))}
              </React.Fragment>
            );
          })}
        </div>

        <section className={styles.expensesSection}>
          <p className={styles.expensesHeading}>{form.expensesHeading}</p>
          <div className={styles.expenseColumnHeads}>
            <span>{form.expenseColumns[0]}</span>
            <span>{form.expenseColumns[1]}</span>
            <span>Φωτο</span>
          </div>
          <div className={styles.expenseGrid}>
            {expenses.map((e, i) => {
              const slot = String(i);
              const photo = photos.photos[slot];
              // A blank trailing row stays blank. The receipt fields appear
              // once the line is actually in use, rather than putting three
              // more empty boxes on every unused line of the sheet.
              const showDetails = hasAnyValue(e) || photo != null || e.items.length > 0;
              const itemsFromScan = scanWrote.current[i]?.items;
              return (
              <div className={styles.expenseRowGroup} key={i}>
                <div className={styles.expenseDescription}>
                  <input
                    type="text"
                    value={e.description}
                    onChange={(ev) => setExpenseField(i, 'description', ev.target.value)}
                    aria-label={`Έξοδο ${i + 1} — περιγραφή`}
                  />
                </div>
                <div className={styles.expenseAmount}>
                  <AmountInput
                    value={e.amount}
                    onValue={(v) => setExpenseField(i, 'amount', v)}
                    aria-label={`Έξοδο ${i + 1} — ποσό`}
                  />
                </div>
                <div className={styles.expensePhoto}>
                  {/* A real <label> wrapping a real file input — not a
                      hidden input triggered by a JS .click(), which failed
                      silently in the prototype's embedded context. The file
                      is compressed and PUT straight to R2; only its key
                      comes back here. */}
                  <label className={styles.photoLabel}>
                    <input
                      ref={(el) => photos.registerInput(slot, el)}
                      type="file"
                      accept="image/*,application/pdf"
                      capture="environment"
                      className={styles.photoInput}
                      onChange={(ev) => photos.attach(slot, ev.target.files?.[0] ?? null)}
                      aria-label={`Φωτογραφία απόδειξης — Έξοδο ${i + 1}`}
                    />
                    <span aria-hidden="true">📎</span>
                  </label>
                  {photo && (
                    <span
                      className={photo.status === 'failed' ? styles.photoFailed : styles.photoChosen}
                    >
                      {/* A thumbnail, not the file name. IMG_20260924_193045.HEIC
                          says nothing about whether the right receipt was
                          photographed, and at this column width it wrapped
                          across several lines and pushed the row apart. */}
                      {photo.previewUrl && (
                        <img
                          src={photo.previewUrl}
                          alt=""
                          className={styles.photoThumb}
                          /* An iPhone photo picked from the library can be
                             HEIC, which Chrome cannot decode — that would
                             leave a broken-image glyph in the row. */
                          onError={(ev) => {
                            ev.currentTarget.style.display = 'none';
                          }}
                        />
                      )}
                      <span className={styles.photoNote} title={photo.name}>
                        {photo.status === 'uploading' && MSG_PHOTO_UPLOADING}
                        {photo.status === 'scanning' && MSG_PHOTO_SCANNING}
                        {photo.status === 'failed' && (photo.message ?? MSG_PHOTO_FAILED)}
                        {photo.status === 'uploaded' && MSG_PHOTO_ATTACHED}
                        {photo.scanned && <em className={styles.photoScanned}> {MSG_FROM_PHOTO}</em>}
                      </span>
                      <button
                        type="button"
                        onClick={() => photos.remove(slot)}
                        aria-label={`Αφαίρεση φωτογραφίας — Έξοδο ${i + 1}`}
                      >
                        ×
                      </button>
                    </span>
                  )}
                </div>

                {showDetails && (
                  <div className={styles.receiptDetails}>
                    {/* Labelled, not placeholdered. A placeholder vanishes
                        the moment the scanner fills the field, so a
                        completed row showed two unnamed values and the
                        field looked as though it were not there at all. */}
                    <label className={styles.receiptField}>
                      <span className={styles.receiptFieldLabel}>{MSG_INVOICE_NO}</span>
                      <input
                        type="text"
                        value={e.invoiceNumber}
                        onChange={(ev) => setExpenseField(i, 'invoiceNumber', ev.target.value)}
                      />
                    </label>
                    {/* type="date" rather than free text: it gives a picker
                        on a phone, hands back YYYY-MM-DD whatever the
                        locale displays, and with min/max the browser
                        refuses the misread year (1970, 2126) that the
                        scanner can produce. The server still checks —
                        nothing that reaches the database is trusted to the
                        client — but this catches it where it can be fixed. */}
                    <label className={styles.receiptField}>
                      <span className={styles.receiptFieldLabel}>{MSG_INVOICE_DATE}</span>
                      <input
                        type="date"
                        min="2000-01-01"
                        max="2100-01-01"
                        value={e.invoiceDate}
                        onChange={(ev) => setExpenseField(i, 'invoiceDate', ev.target.value)}
                      />
                    </label>
                  </div>
                )}

                {/* Under the receipt's own fields, and only on a line in
                    use — the same rule as the fields above, so an unused
                    row of the sheet stays blank. */}
                {showDetails && (
                  <div className={styles.receiptItemsCell}>
                    <ReceiptItems
                      items={e.items}
                      onChange={(next) => setExpenseItems(i, next)}
                      lineAmount={e.amount}
                      rowLabel={`Έξοδο ${i + 1}`}
                      fromScan={itemsFromScan != null && sameItems(itemsFromScan, e.items)}
                    />
                  </div>
                )}

                {photo?.unread && photo.unread.length > 0 && (
                  <div className={styles.receiptUnread} role="status">
                    {MSG_PHOTO_UNREAD_PREFIX} {photo.unread.join(', ')}{' '}
                    {MSG_PHOTO_UNREAD_SUFFIX}
                  </div>
                )}

                {photo?.needsCheck && (
                  <div className={styles.receiptCheck} role="alert">
                    <span
                      className={styles.receiptCheckWarning}
                      // Red and a warning sign only when the model itself
                      // said it was unsure. The ordinary case — a figure
                      // read correctly — is a step in the work, not a
                      // fault, and dressing it as an error teaches people
                      // to dismiss the box without reading it.
                      data-unsure={photo.scanned === 'low' ? '' : undefined}
                    >
                      {photo.scanned === 'low'
                        ? `⚠ ${MSG_PHOTO_LOW_CONFIDENCE}`
                        : MSG_PHOTO_AMOUNT_CHECK}
                    </span>
                    {photo.checkHint && (
                      <span className={styles.receiptCheckHint}>{photo.checkHint}</span>
                    )}
                    <label className={styles.receiptCheckLabel}>
                      <input
                        type="checkbox"
                        checked={photo.checked === true}
                        onChange={() => photos.acknowledge(slot)}
                        aria-label={`${MSG_PHOTO_CONFIRM_CHECKED} — Έξοδο ${i + 1}`}
                      />
                      {MSG_PHOTO_CONFIRM_CHECKED}
                    </label>
                  </div>
                )}
              </div>
              );
            })}
          </div>
          <div className={styles.expenseTotalRow}>
            <span>Σύνολο εξόδων</span>
            <span>{formatCents(totals.expensesCents)}</span>
          </div>
        </section>

        <section className={styles.cashSection}>
          <div className={styles.cashRow}>
            <span className={styles.cashLabel}>Αναμενόμενα (υπολογισμός)</span>
            <span className={styles.cashReadOnly}>{formatCents(totals.expectedCents)}</span>
          </div>
          <div className={styles.cashRow}>
            <label className={styles.cashLabel} htmlFor={`${uid}-counted`}>
              {form.cashLabel}
            </label>
            <span className={styles.cashEntry}>
              {/* The envelope may go below zero; the shortfall is made up
                  at the next close-out (30/10/2026). The iPhone decimal
                  keypad has no minus key, hence the button. */}
              <button
                type="button"
                className={styles.signFlip}
                onClick={() => setCounted(flipSign(counted))}
                aria-label="Αλλαγή προσήμου (αρνητικό ποσό)"
                aria-pressed={counted.trim().startsWith('-')}
              >
                ±
              </button>
              <AmountInput
                id={`${uid}-counted`}
                className={styles.cashInput}
                placeholder={MSG_HINT_ENVELOPE}
                value={counted}
                onValue={(v) => setCounted(sanitizeSignedAmountInput(v))}
              />
            </span>
          </div>
          <div className={styles.cashRow}>
            <span className={styles.cashLabel}>Διαφορά</span>
            <span className={totals.varianceCents === 0 ? styles.varianceZero : styles.varianceNonZero}>
              {formatCents(totals.varianceCents)}
            </span>
          </div>
        </section>

        <div className={styles.field}>
          <SignaturePad
            id={`${uid}-signature`}
            label="Υπογραφή"
            value={signature}
            onChange={setSignature}
          />
        </div>

        {hasAttemptedSave && localMissing.length > 0 && (
          <div role="alert" className={styles.alert}>
            <p>{missingHeader(localMissing.length)}</p>
            <ul>
              {localMissing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        )}

        {serverMessages.length > 0 && (
          <div role="alert" className={styles.alert}>
            <ul>
              {serverMessages.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        )}

        {result?.ok && (
          <div role="status" className={styles.success}>
            <p>Αποθηκεύτηκε.</p>
          </div>
        )}

        {isCorrection && (
          <div className={styles.correctionReason}>
            <label htmlFor={`${uid}-reason`}>Γιατί διορθώνεται;</label>
            <textarea
              id={`${uid}-reason`}
              rows={2}
              value={correctionReason}
              onChange={(e) => setCorrectionReason(e.target.value)}
            />
          </div>
        )}

        <div className={styles.saveBar}>
          <button type="submit" className={styles.saveButton} disabled={saving}>
            {saving ? 'Αποθήκευση…' : 'Αποθήκευση'}
          </button>
        </div>
      </form>
    </div>
  );
}
