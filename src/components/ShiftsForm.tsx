'use client';

/**
 * The CHINA SPICE shifts sheet — driven by the ShiftsForm config in
 * src/lib/forms.ts, never branched on form.id, exactly as LedgerForm is.
 *
 * The same three rules that govern LedgerForm govern this file, for the
 * same reasons; see that file's header for the full argument.
 *
 *   1. It never posts a computed total. computeShift runs here only to show
 *      the manager the arithmetic the paper's TOTAL row shows. Every value
 *      in the payload is the raw string typed into an input, and
 *      src/server/saveReport.ts recomputes from those strings alone.
 *   2. It never parses money itself — sanitizeAmountInput on every
 *      keystroke, parseCents for the live preview, both from
 *      src/lib/money.ts.
 *   3. It never blocks Save. The checklist is shown, not enforced, and only
 *      after a save has been attempted.
 *
 * Layout note. The paper puts the three shift columns side by side. Money
 * inputs in three columns do not fit a 320px phone, so the columns stack
 * vertically below 820px and sit side by side above it. They are NOT tabs:
 * a hidden third shift is a shift someone forgets to fill.
 *
 * The two evening columns are both printed ΒΡΑΔΥ. Stacked on a phone that
 * reads as the same heading twice, so a repeated label gets a small ordinal
 * (ΒΡΑΔΥ 1, ΒΡΑΔΥ 2). The printed word itself is unchanged.
 */

import React, { useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { rowLabelFor, type ShiftsForm as ShiftsFormConfig } from '../lib/forms';
import { formatCents, parseCents, sanitizeAmountInput } from '../lib/money';
import { computeShift, type ShiftTotals } from '../lib/compute';
import { columnToShiftEntry } from './shiftsEntry';
import { MAX_CUSTOM_LABEL, MAX_CUSTOM_LINES } from '../lib/customLine';
import {
  MSG_CORRECTION_REASON,
  MSG_DATE,
  MSG_MANAGER,
  MSG_SIGNATURE,
  missingHeader,
} from '../lib/messages';
import { saveReportAction } from '../app/actions';
import {
  MSG_SAVE_PHOTO_STILL_UPLOADING,
  PHOTO_WAIT_MS,
  bannerMessages,
  callSave,
  settlesWithin,
  type SaveOutcome,
} from './saveOutcome';
import {
  clearShiftsDraft,
  readShiftsDraft,
  sameShiftsFields,
  defaultBusinessDate,
  todayLocalDateString,
  writeShiftsDraft,
  type ShiftColumnDraft,
  type ShiftsDraftFields,
  type StoredShiftsDraft,
} from './shiftsDraft';
import SignaturePad from './SignaturePad';
import { useReceiptPhotos } from './useReceiptPhotos';
import ReceiptItems from './ReceiptItems';
import {
  itemsForPayload,
  normaliseItems,
  type ReceiptItemInput,
} from '../lib/receiptItems';
import {
  MSG_FROM_PHOTO,
  MSG_INVOICE_DATE,
  MSG_INVOICE_NO,
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
} from '../lib/messages';
import {
  MAX_CARD_BRACKETS,
  cardBracketKey,
  filledCardBrackets,
  removeCardBracket,
  withCardBrackets,
  withoutHiddenBrackets,
} from '../lib/cardMachines';
import styles from './ShiftsForm.module.css';

const DRAFT_DEBOUNCE_MS = 500;

interface InvoiceState {
  supplier: string;
  invoiceNumber: string;
  amount: string;
  /** YYYY-MM-DD, or ''. Off the receipt — scanned, or picked by hand. */
  invoiceDate: string;
  /** What the receipt lists — read by the scan, then editable. */
  items: ReceiptItemInput[];
}

function blankInvoice(): InvoiceState {
  return { supplier: '', invoiceNumber: '', amount: '', invoiceDate: '', items: [] };
}

function sameItems(a: ReceiptItemInput[], b: ReceiptItemInput[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Fills in a field an older record does not have. Drafts saved before the
 * receipt date existed are still in managers' localStorage, and a
 * correction loads a night filed before it too; without this those lines
 * arrive with the field absent and `inv.invoiceDate.trim()` throws on the
 * first render, so the sheet would not open at all.
 */
function normaliseInvoice(i: Partial<InvoiceState>): InvoiceState {
  // `items` through its own check, not the spread: absent in every draft
  // written before items existed, and possibly anything in a damaged one.
  return { ...blankInvoice(), ...i, items: normaliseItems(i.items) };
}

/**
 * Exactly one blank line at the end, however the list got there.
 *
 * Growing on the last line was only half the rule. Clearing a line — by
 * deleting its photo, or by emptying its fields — left its own blank
 * behind AND kept the one that had been added below it, so the block
 * gained an empty row every time someone changed their mind. The
 * invariant is "one place to write next", not "append when full".
 */
function withOneTrailingBlank(list: InvoiceState[]): InvoiceState[] {
  const used = (inv: InvoiceState) => hasAnyValue(inv as unknown as Record<string, unknown>);
  const next = [...list];
  while (next.length > 1 && !used(next[next.length - 1]!) && !used(next[next.length - 2]!)) {
    next.pop();
  }
  if (next.length === 0 || used(next[next.length - 1]!)) next.push(blankInvoice());
  return next;
}

/**
 * The invoices on a shift, added up — the brace the paper draws down the
 * right of the ΤΙΜΟΛΟΓΙΑ block with one figure beside it.
 *
 * Never throws: a half-typed amount is normal while someone is still
 * typing, and a subtotal that disappears mid-keystroke is worse than one
 * that ignores the line until it parses.
 */
function invoicesSubtotal(invoices: InvoiceState[]): number {
  let total = 0;
  for (const inv of invoices) {
    if (inv.amount.trim() === '') continue;
    try {
      total += parseCents(inv.amount);
    } catch {
      // Still being typed. Left out until it means something.
    }
  }
  return total;
}

/** Which receipt fields on a line are still empty, in the person's words. */
function blankInvoiceFields(inv: InvoiceState | undefined): string[] {
  if (!inv) return [];
  const out: string[] = [];
  if (inv.supplier.trim() === '') out.push(MSG_FIELD_NAME);
  if (inv.amount.trim() === '') out.push(MSG_FIELD_AMOUNT);
  if (inv.invoiceNumber.trim() === '') out.push(MSG_FIELD_INVOICE_NO);
  if (inv.invoiceDate.trim() === '') out.push(MSG_FIELD_DATE);
  return out;
}

type ShiftColumnState = Omit<ShiftColumnDraft, 'invoices'>;

/**
 * A draft written before invoices moved to the night still carries a list
 * per column. Folding them together loses nothing — the paper never said
 * which shift a receipt belonged to — and throwing the draft away would
 * lose a half-filled sheet someone is in the middle of.
 */
function nightInvoicesFrom(draft: {
  invoices?: InvoiceState[] | ShiftColumnDraft['invoices'];
  shifts: ShiftColumnDraft[];
}): InvoiceState[] {
  const own = (draft.invoices ?? []).map(normaliseInvoice);
  if (own.length > 0) return own;
  const legacy = draft.shifts.flatMap((c) => c.invoices ?? []).map(normaliseInvoice);
  return legacy;
}

function blankColumn(form: ShiftsFormConfig): ShiftColumnState {
  const methods: Record<string, string> = {};
  for (const m of form.methods) methods[m.key] = '';
  return { dineIn: '', ta: '', total: '', methods };
}

/**
 * Whether a line holds anything. A non-empty list counts — an invoice
 * whose items have been typed is in use even with every box still blank —
 * and anything that is neither text nor a list is ignored rather than
 * `.trim()`med, which is what this did before a line could hold a list.
 */
function hasAnyValue(o: Record<string, unknown>): boolean {
  return Object.values(o).some((v) =>
    typeof v === 'string' ? v.trim() !== '' : Array.isArray(v) && v.length > 0
  );
}

/** ΒΡΑΔΥ appears twice on the paper; number repeats so stacked headings differ. */
function shiftHeading(labels: readonly string[], index: number): string {
  const label = labels[index] ?? '';
  const repeats = labels.filter((l) => l === label).length > 1;
  if (!repeats) return label;
  const ordinal = labels.slice(0, index + 1).filter((l) => l === label).length;
  return `${label} ${ordinal}`;
}

export interface ShiftsCorrectionContext {
  businessDate: string;
  initial: ShiftsDraftFields;
  /** null: not approved yet, so an edit rather than a correction. */
  nextRevisionNo: number | null;
}

export default function ShiftsFormSheet({
  form: baseForm,
  correction,
}: {
  form: ShiftsFormConfig;
  /**
   * Present when reopening a filed night, as on the ledger sheet: starts
   * filled in, and when the night is approved it is a correction that
   * requires a reason and carries correctionReason — which migration 0003
   * insists on, not this component.
   */
  correction?: ShiftsCorrectionContext;
}) {
  const uid = useId();

  const seed = correction?.initial;
  // An approved night being corrected (revision, reason) — as opposed to an
  // unapproved one simply being edited, which saves over itself.
  const isCorrection = correction !== undefined && correction.nextRevisionNo !== null;

  /**
   * Card brackets: SIX CARDS split into numbered boxes, one per machine,
   * as many as the manager adds tonight (src/lib/cardMachines.ts). One
   * count for the whole night — a machine is there for every shift.
   *
   * The columns hold a box for every bracket there could be (keyForm), so
   * adding and removing never has to re-key them; the sheet shows and
   * computes only the first cardCount (form), and posts only those.
   */
  const keyForm = useMemo(() => withCardBrackets(baseForm, MAX_CARD_BRACKETS), [baseForm]);
  const [cardCount, setCardCount] = useState(() =>
    Math.max(0, ...(seed?.shifts ?? []).map((c) => filledCardBrackets(c.methods)))
  );
  const form = useMemo(() => withCardBrackets(baseForm, cardCount), [baseForm, cardCount]);

  const [businessDate, setBusinessDate] = useState(
    seed?.businessDate ?? defaultBusinessDate()
  );
  const [closingManagerName, setClosingManagerName] = useState(seed?.closingManagerName ?? '');
  const [signature, setSignature] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const [columns, setColumns] = useState<ShiftColumnState[]>(() =>
    form.shifts.map((_, i) => {
      const base = blankColumn(keyForm);
      const saved = seed?.shifts[i];
      if (!saved) return base;
      const methods: Record<string, string> = { ...base.methods };
      for (const m of keyForm.methods) methods[m.key] = saved.methods[m.key] ?? '';
      return {
        dineIn: saved.dineIn,
        ta: saved.ta,
        total: saved.total,
        methods,
      };
    })
  );

/** A named row: the label is written once, the figures go across. */
interface CustomLineState {
  label: string;
  amounts: string[];
}

function blankCustomLine(form: ShiftsFormConfig): CustomLineState {
  return { label: '', amounts: form.shifts.map(() => '') };
}

function customLineTouched(l: CustomLineState): boolean {
  return l.label.trim() !== '' || l.amounts.some((a) => a.trim() !== '');
}

/** Same rule as the invoice list: exactly one spare row at the bottom,
 *  however the list got into its current state. */
function withOneTrailingLine(list: CustomLineState[], form: ShiftsFormConfig): CustomLineState[] {
  const next = [...list];
  while (
    next.length > 1 &&
    !customLineTouched(next[next.length - 1]!) &&
    !customLineTouched(next[next.length - 2]!)
  ) {
    next.pop();
  }
  // Only ever ADD the spare row, and only while there is room. Slicing
  // the result instead would silently drop a filled line off the end of
  // an oversized list — losing money off a till sheet to tidy a list is
  // never the right trade.
  if (
    next.length < MAX_CUSTOM_LINES &&
    (next.length === 0 || customLineTouched(next[next.length - 1]!))
  ) {
    next.push(blankCustomLine(form));
  }
  return next;
}

/**
 * Restores the night's named rows from a draft.
 *
 * Drafts written before this existed carry the figure under a method
 * called OTHER — the config row that used to render the blank line. That
 * money is folded into an UNNAMED row rather than dropped: the save will
 * then refuse it with "name this line", which is the right outcome. A
 * silently discarded figure is the one thing a till sheet must never do.
 */
function customLinesFrom(seed: ShiftsDraftFields | null, form: ShiftsFormConfig): CustomLineState[] {
  if (!form.allowCustomLines) return [];
  if (seed?.customLines && seed.customLines.length > 0) {
    return withOneTrailingLine(
      seed.customLines.map((l) => ({
        label: l.label,
        amounts: form.shifts.map((_, i) => l.amounts[i] ?? ''),
      })),
      form
    );
  }
  const legacy = form.shifts.map((_, i) => seed?.shifts[i]?.methods?.OTHER ?? '');
  if (legacy.some((a) => a.trim() !== '')) {
    return withOneTrailingLine([{ label: '', amounts: legacy }], form);
  }
  return [blankCustomLine(form)];
}

  /** One list for the night, as the paper has it (migration 0005). */
  const [invoices, setInvoices] = useState<InvoiceState[]>(() => {
    const seeded = seed ? nightInvoicesFrom(seed) : [];
    return seeded.length > 0 ? seeded : [blankInvoice()];
  });

  /** The printed sheet's spare line, with somewhere to write its name. */
  const [customLines, setCustomLines] = useState<CustomLineState[]>(() =>
    customLinesFrom(seed ?? null, form)
  );

  function setCustomLabel(index: number, raw: string): void {
    setCustomLines((prev) =>
      withOneTrailingLine(
        prev.map((l, i) => (i === index ? { ...l, label: raw.replace(/\s+/g, ' ') } : l)),
        form
      )
    );
  }

  function setCustomAmount(index: number, col: number, raw: string): void {
    setCustomLines((prev) =>
      withOneTrailingLine(
        prev.map((l, i) =>
          i === index
            ? { ...l, amounts: l.amounts.map((a, c) => (c === col ? sanitizeAmountInput(raw) : a)) }
            : l
        ),
        form
      )
    );
  }

  /** Exactly what the scan wrote into each line, so removal can undo it. */
  const scanWrote = useRef<Record<string, Partial<InvoiceState>>>({});

  /** The night's invoices as last committed, readable after an await. */
  const invoicesRef = useRef(invoices);
  invoicesRef.current = invoices;

  /**
   * Receipt photos, one slot per invoice line, keyed `${shift}-${line}`.
   * The photo itself never enters the draft — a draft is JSON in
   * localStorage and a photo is not. Only the stored object's key is
   * posted, on save.
   */
  /**
   * The hook, reachable from inside its own options. slotsForPages has
   * to ask which lines already hold a photo, and that answer only exists
   * once the hook is built — the callbacks all run later, by which time
   * this is filled in.
   */
  const photosRef = useRef<ReturnType<typeof useReceiptPhotos> | null>(null);

  const photos = useReceiptPhotos({
    restaurantId: form.id,
    businessDate,
    blankFields: (slot: string) => blankInvoiceFields(invoicesRef.current[Number(slot)]),
    /**
     * A scanned PDF of the day's receipts gets one page per invoice line:
     * the line that was clicked, then EMPTY lines below it, then new ones
     * appended at the end.
     *
     * The first version took the clicked line and the next N-1 by
     * position. Attaching a five-page scan to line 1 overwrote lines 2
     * to 5 whatever was already on them — receipts someone had typed in
     * by hand, replaced without being asked.
     *
     * It also fought the one-blank-line invariant: a line holding only a
     * photo has no typed fields, so withOneTrailingBlank counted it as
     * unused and popped the very lines this had just added.
     */
    slotsForPages: (firstSlot: string, pageCount: number) => {
      const start = Number(firstSlot);
      if (!Number.isFinite(start)) return [firstSlot];

      const list = invoicesRef.current;
      const taken = (i: number) => {
        const inv = list[i];
        if (!inv) return false;
        const typed = hasAnyValue(inv as unknown as Record<string, unknown>);
        return typed || (photosRef.current?.keyFor(String(i)) ?? '') !== '';
      };

      // The clicked line always takes page one, even if it already has
      // something: that is a person deliberately replacing it.
      const chosen = [String(start)];
      for (let i = start + 1; i < list.length && chosen.length < pageCount; i += 1) {
        if (!taken(i)) chosen.push(String(i));
      }
      let append = list.length;
      while (chosen.length < pageCount) {
        chosen.push(String(append));
        append += 1;
      }

      setInvoices((prev) => {
        const next = [...prev];
        // Grown, never trimmed. withOneTrailingBlank is deliberately not
        // called here — it would pop these lines straight back off, since
        // a line carrying only a photo has nothing typed in it yet. The
        // invariant restores itself as the scans fill the fields in.
        while (next.length < append) next.push(blankInvoice());
        if (next.length === 0) next.push(blankInvoice());
        return next;
      });

      return chosen;
    },
    onRemoved: (slot) => {
      const line = Number(slot);
      const written = scanWrote.current[slot];
      delete scanWrote.current[slot];
      if (!written) return;
      // Clears a field ONLY if it still holds exactly what the scan put
      // there. Anything corrected by hand since is the person's own work
      // and survives — removing a photo must not quietly undo typing.
      setInvoices((prev) =>
        // Through the same invariant: clearing a line must not leave its
        // own blank AND the one added below it.
        withOneTrailingBlank(
          prev.map((inv, j) => {
            if (j !== line) return inv;
            const next = { ...inv };
            for (const k of ['supplier', 'invoiceNumber', 'amount', 'invoiceDate'] as const) {
              if (written[k] !== undefined && next[k] === written[k]) next[k] = '';
            }
            // Same rule for the item list: gone only if untouched since
            // the scan wrote it.
            if (written.items && sameItems(next.items, written.items)) next.items = [];
            return next;
          })
        )
      );
    },
    onScanned: (slot, scan) => {
      const line = Number(slot);

      // Read through the ref, not through this closure: the scan lands
      // seconds after the photo was chosen and must not overwrite
      // anything typed in the meantime.
      const inv = invoicesRef.current[line];
      if (!inv) return;

      // Fills only what is still blank. The person holding the receipt
      // outranks the model, and a figure that silently replaced a typed
      // one would be the worst kind of wrong: authoritative-looking and
      // unread.
      const patch: Partial<InvoiceState> = {};
      const fields: string[] = [];

      if (inv.amount.trim() === '' && scan.totalCents != null) {
        patch.amount = formatCents(scan.totalCents);
        fields.push(patch.amount);
      }
      if (inv.supplier.trim() === '' && scan.supplier) {
        patch.supplier = scan.supplier;
        fields.push(scan.supplier);
      }
      if (inv.invoiceNumber.trim() === '' && scan.invoiceNumber) {
        patch.invoiceNumber = scan.invoiceNumber;
        fields.push(scan.invoiceNumber);
      }
      if (inv.invoiceDate.trim() === '' && scan.date) {
        patch.invoiceDate = scan.date;
        fields.push(scan.date);
      }
      // Items follow the rule of every other field: only into an empty
      // list, so anything typed by hand in the meantime survives.
      const scannedItems = scan.items ?? [];
      if (inv.items.length === 0 && scannedItems.length > 0) {
        patch.items = scannedItems.map((it) => ({
          name: it.name,
          qty: it.qty,
          // An unread price stays EMPTY, not 0,00: an empty box asks to
          // be filled in, a zero looks like an answer.
          amount: it.amountCents == null ? '' : formatCents(it.amountCents),
        }));
        fields.push(MSG_ITEMS_COUNT(patch.items.length));
      }

      if (Object.keys(patch).length > 0) {
        scanWrote.current[slot] = patch;
        setInvoices((prev) =>
          withOneTrailingBlank(prev.map((row, j) => (j === line ? { ...row, ...patch } : row)))
        );
      }
      const after = { ...inv, ...patch };
      const unread = blankInvoiceFields(after);

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


  const [result, setResult] = useState<SaveOutcome | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [draftChoice, setDraftChoice] = useState<StoredShiftsDraft | null>(null);
  const [saving, startSaveTransition] = useTransition();

  const fields: ShiftsDraftFields = useMemo(
    () => ({
      businessDate,
      closingManagerName,
      signature,
      shifts: columns,
      invoices,
      customLines,
    }),
    [businessDate, closingManagerName, signature, columns, invoices, customLines]
  );

  // The state the sheet started at. Compared by value, so a date that merely
  // defaults to today is not "typed" and a mis-tap leaves no draft behind.
  const baselineRef = useRef<ShiftsDraftFields>(fields);
  const isDirty = !sameShiftsFields(fields, baselineRef.current);

  function applyDraft(draft: ShiftsDraftFields) {
    setBusinessDate(draft.businessDate);
    setClosingManagerName(draft.closingManagerName);
    setSignature(draft.signature);
    // Re-key methods through the config so a draft written before a method
    // was added or removed still lands in the right rows.
    setColumns(
      form.shifts.map((_, i) => {
        const saved = draft.shifts[i];
        const base = blankColumn(keyForm);
        if (!saved) return base;
        const methods: Record<string, string> = { ...base.methods };
        for (const m of keyForm.methods) methods[m.key] = saved.methods[m.key] ?? '';
        return {
          dineIn: saved.dineIn,
          ta: saved.ta,
          total: saved.total,
          methods,
        };
      })
    );
    // Folds a pre-0005 draft's per-column lists into the night's one list.
    const night = nightInvoicesFrom(draft);
    setInvoices(night.length > 0 ? night : [blankInvoice()]);
    setCustomLines(customLinesFrom(draft, form));
    setCardCount(Math.max(0, ...draft.shifts.map((c) => filledCardBrackets(c.methods ?? {}))));
    baselineRef.current = draft;
    setDraftChoice(null);
  }

  // Read once on mount. Today's date -> restore silently. Any other date ->
  // ask and name it, never load older figures under today's date.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // A correction never restores a draft — see the ledger sheet's note.
    if (correction) return;
    const draft = readShiftsDraft(window.localStorage, form.id);
    if (!draft) return;
    // Always ask, even for today's date. A draft cannot carry the receipt
    // PHOTOS — they live in R2 under keys held in memory, and a reload
    // loses them. Restoring silently produced a sheet that looked
    // complete, carrying amounts and supplier names read off receipts
    // whose photos were no longer attached to anything.
    setDraftChoice(draft);
    // Mount only — must not re-run as the manager types.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.id]);

  useEffect(() => {
    if (correction) return;
    if (!isDirty) return;
    if (typeof window === 'undefined') return;
    const timer = window.setTimeout(() => {
      writeShiftsDraft(window.localStorage, form.id, fields);
    }, DRAFT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [fields, isDirty, form.id]);

  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (!isDirty) return;
      if (typeof window !== 'undefined') {
        writeShiftsDraft(window.localStorage, form.id, fields);
      }
      e.preventDefault();
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [fields, isDirty, form.id]);

  // Back link: dirty -> save silently and go. Clean -> just go. No prompt.
  function handleBackClick() {
    if (isDirty && typeof window !== 'undefined') {
      writeShiftsDraft(window.localStorage, form.id, fields);
    }
  }

  function updateColumn(index: number, patch: Partial<ShiftColumnState>) {
    setColumns((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  function addCardBracket() {
    if (cardCount >= MAX_CARD_BRACKETS || !baseForm.cardRowKey) return;
    const cardKey = baseForm.cardRowKey;
    // The first bracket takes over what was already typed in SIX CARDS,
    // shift by shift, so the same money is never in two boxes.
    if (cardCount === 0) {
      setColumns((prev) =>
        prev.map((c) =>
          (c.methods[cardKey] ?? '').trim() === ''
            ? c
            : { ...c, methods: { ...c.methods, [cardBracketKey(1)]: c.methods[cardKey]!, [cardKey]: '' } }
        )
      );
    }
    setCardCount(cardCount + 1);
  }

  function removeBracket(n: number) {
    setColumns((prev) =>
      prev.map((c) => ({
        ...c,
        // Every possible bracket keeps a box (keyForm), so the last one
        // goes back to blank rather than missing.
        methods: { ...removeCardBracket(c.methods, cardCount, n), [cardBracketKey(cardCount)]: '' },
      }))
    );
    setCardCount(cardCount - 1);
  }

  function setMethod(index: number, key: string, raw: string) {
    setColumns((prev) =>
      prev.map((c, i) =>
        i === index ? { ...c, methods: { ...c.methods, [key]: sanitizeAmountInput(raw) } } : c
      )
    );
  }

  function setInvoice(line: number, patch: Partial<InvoiceState>) {
    setInvoices((prev) => {
      // One blank at the end, whether this filled a line or emptied one.
      return withOneTrailingBlank(prev.map((inv, j) => (j === line ? { ...inv, ...patch } : inv)));
    });
  }

  const totals: ShiftTotals[] = useMemo(
    () =>
      columns.map((c, i) => computeShift(form, columnToShiftEntry(form, c, customLines, i))),
    [columns, customLines, form]
  );

  const dayExpected = totals.reduce((a, t) => a + t.expectedCents, 0);
  // Invoices are settled against the day, not a shift (shiftsEntry.ts), so
  // they join the accounted side once, here — exactly as saveReport.ts
  // adds them before storing. Leaving them out made a night that balanced
  // read as short by its invoices on screen while the archive said 0.
  const dayAccounted =
    totals.reduce((a, t) => a + t.accountedCents, 0) + invoicesSubtotal(invoices);
  const dayDifference = dayAccounted - dayExpected;

  const missing = useMemo(() => {
    const m: string[] = [];
    if (!businessDate) m.push(MSG_DATE);
    if (!closingManagerName.trim()) m.push(MSG_MANAGER);
    if (!signature.trim()) m.push(MSG_SIGNATURE);
    if (isCorrection && !correctionReason.trim()) m.push(MSG_CORRECTION_REASON);
    return m;
  }, [businessDate, closingManagerName, signature, isCorrection, correctionReason]);

  async function handleSave() {
    setAttempted(true);

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

      const savedFields = fields;

      const payload = {
        restaurantId: form.id,
        businessDate: savedFields.businessDate,
        closingManagerName: savedFields.closingManagerName,
        signature: savedFields.signature,
        ...(isCorrection ? { correctionReason: correctionReason.trim() } : {}),
        shifts: savedFields.shifts.map((c, i) => ({
          shiftIndex: i,
          dineIn: c.dineIn,
          ta: c.ta,
          total: c.total,
          // Only the brackets on screen; see keyForm above.
          methods: withoutHiddenBrackets(c.methods, cardCount),
        })),
        // Only lines someone actually touched. The sheet always carries a
        // spare blank one, and sending it would be sending a row that does
        // not exist.
        customLines: (savedFields.customLines ?? [])
          .filter((l) => l.label.trim() !== '' || l.amounts.some((a) => a.trim() !== ''))
          .map((l) => ({ label: l.label.trim(), amounts: l.amounts })),
        // Map BEFORE filtering. A photo's slot is keyed by the line's
        // position on the sheet, and filtering first renumbers the lines —
        // so a blank line anywhere above would shift every photo below it
        // onto the wrong invoice.
        invoices: savedFields.invoices
          .map((inv, j) => ({
            supplier: inv.supplier,
            invoiceNumber: inv.invoiceNumber,
            amount: inv.amount,
            invoiceDate: inv.invoiceDate ?? '',
            // From the hook's ref, not from state: this runs after an await,
            // where a render-captured value would be stale.
            receiptPhotoUrl: photos.keyFor(String(j)),
            // Touched lines only, as strings: the server parses amounts.
            items: itemsForPayload(inv.items ?? []),
          }))
          // A line carrying only a photo still counts: the receipt is
          // attached even if nobody typed the supplier yet.
          .filter(
            (inv) =>
              hasAnyValue({
                supplier: inv.supplier,
                invoiceNumber: inv.invoiceNumber,
                amount: inv.amount,
                invoiceDate: inv.invoiceDate,
              }) ||
              inv.receiptPhotoUrl !== '' ||
              inv.items.length > 0
          ),
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
        writeShiftsDraft(window.localStorage, form.id, savedFields);
      }
      if (response.ok && typeof window !== 'undefined') {
        if (!correction) clearShiftsDraft(window.localStorage, form.id);
        baselineRef.current = savedFields;
      }
    });
  }

  // The date / manager / signature lines are already on the live checklist
  // above; everything else the save refused for is shown here, the only
  // place it can appear (src/components/saveOutcome.ts).
  const serverMessages = bannerMessages(result, attempted ? missing : []);

  return (
    <div className={styles.page}>
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
        <div role="alert" className={styles.draftChoice}>
          <p>
            Υπάρχει ημιτελές έντυπο από {draftChoice.businessDate || 'άλλη ημερομηνία'}.
          </p>
          <p className={styles.draftChoiceWarning}>{MSG_DRAFT_NO_PHOTOS}</p>
          <div className={styles.draftChoiceButtons}>
            <button type="button" onClick={() => applyDraft(draftChoice)}>
              Συνέχεια σε εκείνο
            </button>
            <button
              type="button"
              onClick={() => {
                if (typeof window !== 'undefined') clearShiftsDraft(window.localStorage, form.id);
                setDraftChoice(null);
              }}
            >
              Νέο έντυπο
            </button>
          </div>
        </div>
      )}

      <form
        className={styles.sheet}
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
      >
        <header className={styles.letterhead}>
          <h1 className={styles.legalName}>{form.legalName}</h1>
          {form.tagline && <p className={styles.tagline}>{form.tagline}</p>}
          <p className={styles.contact}>
            {form.address} · {form.phone}
          </p>
        </header>

        <div className={styles.topFields}>
          <label htmlFor={`${uid}-date`}>Ημερομηνία</label>
          <input
            id={`${uid}-date`}
            type="date"
            value={businessDate}
            onChange={(e) => setBusinessDate(e.target.value)}
          />
        </div>

        {/* ONE grid, the way the paper is printed: payment methods down
            the left, the three shifts across. This used to render three
            stacked copies of the whole sheet — a different document from
            the one these managers have filled in for years. */}
        <div
          className={styles.grid}
          style={{ '--zet-grid-count': form.shifts.length } as React.CSSProperties}
        >
          {form.tameioRows.map((row, ri) => (
            <div key={row.key} className={styles.gridRow}>
              <span className={styles.rowLabel}>{ri === 0 ? 'ΤΑΜΕΙΟ' : ''}</span>
              {form.shifts.map((_, i) => (
                <label key={i} className={styles.cell}>
                  {/* The printed sheet repeats "Dine in: / T/A: / Total:"
                      inside every column instead of naming them once on
                      the left, so this does too. */}
                  <span className={styles.cellLabel}>{row.label}</span>
                  {/* Dine in and T/A take words as well as figures — on
                      the paper they are as often a note as a number. Total
                      does not: it is what the night reconciles against, so
                      it keeps the strip-as-you-type guard that stops a
                      stray letter swallowing a real figure. */}
                  <input
                    className={styles.cellAmount}
                    inputMode={row.key === 'total' ? 'decimal' : 'text'}
                    placeholder={MSG_HINT_Z_REPORT}
                    aria-label={`${shiftHeading(form.shifts, i)} — ${row.label}`}
                    value={columns[i]![row.key]}
                    onChange={(e) =>
                      updateColumn(i, {
                        [row.key]:
                          row.key === 'total'
                            ? sanitizeAmountInput(e.target.value)
                            : e.target.value,
                      })
                    }
                  />
                </label>
              ))}
            </div>
          ))}

          {/* The shift names sit BELOW ΤΑΜΕΙΟ and above CASH on the paper,
              not at the top of the sheet. */}
          <div className={styles.gridRow}>
            <span className={styles.rowLabel} />
            {form.shifts.map((_, i) => (
              <span key={i} className={styles.colHeading}>
                {shiftHeading(form.shifts, i)}
              </span>
            ))}
          </div>

          {form.methods
            // Hidden on a fresh sheet, shown on a night that used it. See
            // the note on `retired` in forms.ts for why the entry stays.
            .filter(
              (m) =>
                !m.retired ||
                columns.some((c) => (c.methods[m.key] ?? '').trim() !== '')
            )
            .map((m, idx, shown) => (
            <React.Fragment key={m.key}>
            {/* Card brackets: their sum, per shift, above the first of them,
                under the card row's own name. Read-only — the brackets are
                what is typed, and computeShift counts each of them once. */}
            {m.countsAs && shown[idx - 1]?.countsAs !== m.countsAs && (
              <div className={`${styles.gridRow} ${styles.gridMachineTotalRow}`}>
                <span className={`${styles.rowLabel} ${styles.visaOnly}`} data-visa="VISA">
                  {form.methods.find((x) => x.key === m.countsAs)?.label ?? m.countsAs}
                </span>
                {form.shifts.map((_, i) => (
                  <span key={i} className={styles.cellTotal}>
                    {formatCents(
                      form.methods
                        .filter((x) => x.countsAs === m.countsAs)
                        .reduce((a, x) => a + parseCents(columns[i]!.methods[x.key] ?? ''), 0)
                    )}
                  </span>
                ))}
              </div>
            )}
            <div className={`${styles.gridRow} ${m.countsAs ? styles.gridMachineRow : ''}`}>
              {/* The bracket hangs off the LABEL cell, not the row: the row
                  is `display: contents`, so it generates no box — its
                  position:relative does nothing and an absolutely
                  positioned ::before escapes to the page corner. */}
              <span
                className={[
                  styles.rowLabel,
                  m.visaBracket === 'start' ? styles.visaStart : '',
                  m.visaBracket === 'end' ? styles.visaEnd : '',
                  m.visaBracket === 'only' ? styles.visaOnly : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                data-visa={m.visaBracket ? 'VISA' : undefined}
              >
                {m.label || ' '}
                {m.countsAs && (
                  <button
                    type="button"
                    className={styles.bracketRemove}
                    onClick={() => removeBracket(Number(m.label))}
                    aria-label={`Αφαίρεση ${form.methods.find((x) => x.key === m.countsAs)?.label ?? ''} ${m.label}`}
                  >
                    ×
                  </button>
                )}
              </span>
              {form.shifts.map((_, i) => (
                <input
                  key={i}
                  className={styles.cellAmount}
                  inputMode="decimal"
                  placeholder={m.isCash ? MSG_HINT_ENVELOPE : undefined}
                  aria-label={`${shiftHeading(form.shifts, i)} — ${
                    m.countsAs ? rowLabelFor(form, m.key) : m.label || 'Άλλο'
                  }`}
                  value={columns[i]!.methods[m.key] ?? ''}
                  onChange={(e) => setMethod(i, m.key, e.target.value)}
                />
              ))}
            </div>
            {/* Under SIX CARDS while it has no brackets, under the last
                bracket once it has. */}
            {((m.key === form.cardRowKey && cardCount === 0) ||
              (m.countsAs && shown[idx + 1]?.countsAs !== m.countsAs)) &&
              cardCount < MAX_CARD_BRACKETS && (
                <div className={`${styles.gridRow} ${styles.gridMachineRow}`}>
                  <span className={styles.rowLabel}>
                    {/* Just "+": the label column is a few characters wide on
                        a 320px phone, and the brackets above say what it adds. */}
                    <button
                      type="button"
                      className={styles.bracketAdd}
                      onClick={addCardBracket}
                      aria-label="Προσθήκη μηχανήματος καρτών"
                    >
                      +
                    </button>
                  </span>
                  {form.shifts.map((_, i) => (
                    <span key={i} className={styles.cellTotal} />
                  ))}
                </div>
              )}
            </React.Fragment>
          ))}

          {/* The printed spare line, with a box to write its name in.
              Rendered after the configured methods because that is where
              it sits on the paper: below SKASH, above TOTAL. */}
          {form.allowCustomLines &&
            customLines.map((line, li) => (
              <div key={li} className={styles.gridRow}>
                <input
                  className={styles.rowLabelInput}
                  value={line.label}
                  maxLength={MAX_CUSTOM_LABEL}
                  placeholder="+ όνομα"
                  aria-label={`Όνομα γραμμής ${li + 1}`}
                  onChange={(e) => setCustomLabel(li, e.target.value)}
                />
                {form.shifts.map((_, i) => (
                  <input
                    key={i}
                    className={styles.cellAmount}
                    inputMode="decimal"
                    aria-label={`${shiftHeading(form.shifts, i)} — ${
                      line.label.trim() || `γραμμή ${li + 1}`
                    }`}
                    value={line.amounts[i] ?? ''}
                    onChange={(e) => setCustomAmount(li, i, e.target.value)}
                  />
                ))}
              </div>
            ))}

          {/* TOTAL is a row on the paper, one figure per column. */}
          <div className={`${styles.gridRow} ${styles.gridTotalRow}`}>
            <span className={styles.rowLabel}>TOTAL</span>
            {form.shifts.map((_, i) => (
              <span key={i} className={styles.cellTotal}>
                {formatCents(totals[i]!.accountedCents)}
              </span>
            ))}
          </div>
          <div className={`${styles.gridRow} ${styles.gridComputedRow}`}>
            <span className={styles.rowLabel}>Αναμενόμενα</span>
            {form.shifts.map((_, i) => (
              <span key={i} className={styles.cellTotal}>
                {formatCents(totals[i]!.expectedCents)}
              </span>
            ))}
          </div>
          <div className={`${styles.gridRow} ${styles.gridComputedRow}`}>
            <span className={styles.rowLabel}>Διαφορά</span>
            {form.shifts.map((_, i) => (
              <span
                key={i}
                className={styles.cellTotal}
                data-off={totals[i]!.differenceCents !== 0 ? '' : undefined}
              >
                {formatCents(totals[i]!.differenceCents)}
              </span>
            ))}
          </div>
        </div>

        {totals.some((t) => t.splitMismatch) && (
          <p className={styles.hint}>
            Dine in + T/A δεν βγάζουν το Total. Δεν εμποδίζει την αποθήκευση.
          </p>
        )}

        {/* ONE block for the night, as the paper has it: the receipts are
            written once across the columns and braced to a single figure,
            and nothing on the sheet says which till paid which one. */}
        <section className={styles.invoiceSection} aria-label="ΤΙΜΟΛΟΓΙΑ">
          <h3 className={styles.blockHeading}>ΤΙΜΟΛΟΓΙΑ</h3>
                  {invoices.map((inv, j) => {
                    const photoKey = String(j);
                    return (
                      <div key={j} className={styles.invoiceLine}>
                        {/* Supplier, invoice number and amount on ONE
                            line, because that is how the paper is
                            written: "ΣΚΛΑΒΕΝΙΤΗΣ 30/63994 27,44".
                            Each caption belongs to its own field rather
                            than to a header row above them: a header row
                            cannot wrap, so at phone width it slid out of
                            step with the boxes and the labels collided. */}
                        <label className={styles.invoiceField}>
                          <span className={styles.invoiceFieldLabel}>Προμηθευτής</span>
                          <input
                            className={styles.invoiceSupplier}
                            value={inv.supplier}
                            onChange={(e) => setInvoice(j, { supplier: e.target.value })}
                          />
                        </label>
                        <label className={styles.invoiceField}>
                          <span className={styles.invoiceFieldLabel}>{MSG_INVOICE_NO}</span>
                          <input
                            className={styles.invoiceNumber}
                            value={inv.invoiceNumber}
                            onChange={(e) => setInvoice(j, { invoiceNumber: e.target.value })}
                          />
                        </label>
                        <label className={`${styles.invoiceField} ${styles.invoiceFieldAmount}`}>
                          <span className={styles.invoiceFieldLabel}>Ποσό</span>
                          <input
                            className={styles.invoiceAmount}
                            inputMode="decimal"
                            value={inv.amount}
                            onChange={(e) =>
                              setInvoice(j, { amount: sanitizeAmountInput(e.target.value) })
                            }
                          />
                        </label>
                        <label className={styles.photoButton}>
                          <span>📷 Φωτογραφία</span>
                          <input
                            ref={(el) => photos.registerInput(photoKey, el)}
                            type="file"
                            accept="image/*,application/pdf"
                            capture="environment"
                            className={styles.fileInput}
                            aria-label={`Φωτογραφία τιμολογίου, γραμμή ${j + 1}`}
                            onChange={(e) => photos.attach(photoKey, e.target.files?.[0] ?? null)}
                          />
                        </label>
                        {(hasAnyValue(inv as unknown as Record<string, unknown>) ||
                          photos.photos[photoKey] != null) && (
                          <div className={styles.receiptDetails}>
                            {/* Labelled, not placeholdered: a placeholder
                                vanishes the moment the scanner fills the
                                field, leaving an unnamed value. */}
                            <label className={styles.receiptField}>
                              <span className={styles.receiptFieldLabel}>{MSG_INVOICE_DATE}</span>
                              {/* type="date": a picker on a phone,
                                  YYYY-MM-DD back whatever the locale
                                  shows, and min/max refuses the misread
                                  year the scanner can produce. */}
                              <input
                                type="date"
                                min="2000-01-01"
                                max="2100-01-01"
                                value={inv.invoiceDate}
                                onChange={(e) => setInvoice(j, { invoiceDate: e.target.value })}
                              />
                            </label>
                          </div>
                        )}
                        {/* Under the line's own fields, and only on a line
                            in use — the spare blank line stays blank. */}
                        {(hasAnyValue(inv as unknown as Record<string, unknown>) ||
                          photos.photos[photoKey] != null) && (
                          <div className={styles.receiptItemsCell}>
                            <ReceiptItems
                              items={inv.items}
                              onChange={(next) => setInvoice(j, { items: next })}
                              lineAmount={inv.amount}
                              rowLabel={`Τιμολόγιο ${j + 1}`}
                              fromScan={
                                scanWrote.current[photoKey]?.items != null &&
                                sameItems(scanWrote.current[photoKey].items, inv.items)
                              }
                            />
                          </div>
                        )}
                        {photos.photos[photoKey] && (
                          <p
                            className={
                              photos.photos[photoKey].status === 'failed'
                                ? styles.photoFailedLine
                                : styles.photoName
                            }
                          >
                            {/* A thumbnail rather than the file name: a
                                camera name says nothing about whether the
                                right receipt was photographed, and it is
                                long enough to wrap the row apart. */}
                            {photos.photos[photoKey].previewUrl && (
                              <img
                                src={photos.photos[photoKey].previewUrl}
                                alt=""
                                className={styles.photoThumb}
                                onError={(ev) => {
                                  ev.currentTarget.style.display = 'none';
                                }}
                              />
                            )}
                            <span
                              className={styles.photoNote}
                              title={photos.photos[photoKey].name}
                            >
                              {photos.photos[photoKey].status === 'uploading' &&
                                MSG_PHOTO_UPLOADING}
                              {photos.photos[photoKey].status === 'scanning' && MSG_PHOTO_SCANNING}
                              {photos.photos[photoKey].status === 'failed' &&
                                (photos.photos[photoKey].message ?? MSG_PHOTO_FAILED)}
                              {photos.photos[photoKey].status === 'uploaded' && MSG_PHOTO_ATTACHED}
                              {photos.photos[photoKey].scanned && (
                                <em className={styles.photoScanned}> {MSG_FROM_PHOTO}</em>
                              )}
                            </span>
                            <button
                              type="button"
                              className={styles.photoRemove}
                              onClick={() => photos.remove(photoKey)}
                              aria-label={`Αφαίρεση φωτογραφίας, γραμμή ${j + 1}`}
                            >
                              Αφαίρεση
                            </button>
                          </p>
                        )}
                        {photos.photos[photoKey]?.unread?.length ? (
                          <p className={styles.invoiceUnread} role="status">
                            {MSG_PHOTO_UNREAD_PREFIX}{' '}
                            {photos.photos[photoKey].unread?.join(', ')}{' '}
                            {MSG_PHOTO_UNREAD_SUFFIX}
                          </p>
                        ) : null}
                        {photos.photos[photoKey]?.needsCheck && (
                          <p className={styles.invoiceCheck} role="alert">
                            <span
                              className={styles.invoiceCheckWarning}
                              data-unsure={
                                photos.photos[photoKey].scanned === 'low' ? '' : undefined
                              }
                            >
                              {photos.photos[photoKey].scanned === 'low'
                                ? `⚠ ${MSG_PHOTO_LOW_CONFIDENCE}`
                                : MSG_PHOTO_AMOUNT_CHECK}
                            </span>
                            {photos.photos[photoKey].checkHint && (
                              <span className={styles.invoiceCheckHint}>
                                {photos.photos[photoKey].checkHint}
                              </span>
                            )}
                            <label className={styles.invoiceCheckLabel}>
                              <input
                                type="checkbox"
                                checked={photos.photos[photoKey].checked === true}
                                onChange={() => photos.acknowledge(photoKey)}
                                aria-label={`${MSG_PHOTO_CONFIRM_CHECKED}, γραμμή ${j + 1}`}
                              />
                              {MSG_PHOTO_CONFIRM_CHECKED}
                            </label>
                          </p>
                        )}
                      </div>
                    );
                  })}
                  {invoicesSubtotal(invoices) > 0 && (
                    <div className={styles.invoiceSubtotal}>
                      <span>Σύνολο τιμολογίων</span>
                      <span>{formatCents(invoicesSubtotal(invoices))}</span>
                    </div>
                  )}
        </section>

        <dl className={styles.dayTotals}>
          <div>
            <dt>Ημέρα — αναμενόμενα</dt>
            <dd>{formatCents(dayExpected)}</dd>
          </div>
          <div>
            <dt>Ημέρα — σύνολο</dt>
            <dd>{formatCents(dayAccounted)}</dd>
          </div>
          <div className={dayDifference === 0 ? '' : styles.differenceRow}>
            <dt>Ημέρα — διαφορά</dt>
            <dd>{formatCents(dayDifference)}</dd>
          </div>
        </dl>

        <div className={styles.footerFields}>
          <div className={styles.fieldRow}>
            <label htmlFor={`${uid}-manager`}>Υπεύθυνος ταμείου</label>
            <input
              id={`${uid}-manager`}
              value={closingManagerName}
              onChange={(e) => setClosingManagerName(e.target.value)}
              autoComplete="name"
              placeholder={MSG_MANAGER_NAME_PLACEHOLDER}
            />
          </div>
          <SignaturePad
            id={`${uid}-signature`}
            label="Υπογραφή"
            value={signature}
            onChange={setSignature}
          />
        </div>

        {attempted && missing.length > 0 && (
          <div role="alert" className={styles.alert}>
            <p>{missingHeader(missing.length)}</p>
            <ul>
              {missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        )}

        {(result?.ok || serverMessages.length > 0) && (
          <div role="alert" className={styles.alert}>
            {result?.ok ? (
              <p>Αποθηκεύτηκε.</p>
            ) : (
              serverMessages.map((m) => <p key={m}>{m}</p>)
            )}
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
          <button type="submit" disabled={saving}>
            {saving ? 'Αποθήκευση…' : 'Αποθήκευση'}
          </button>
        </div>
      </form>
    </div>
  );
}
