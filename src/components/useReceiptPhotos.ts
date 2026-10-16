'use client';

/**
 * One implementation of attaching a receipt photo, shared by every form
 * that has one.
 *
 * The rules below are subtle and were each arrived at by getting them
 * wrong first — a save that outran its upload and silently dropped the
 * photo, a failure message that named no cause, a scanned amount that
 * overwrote a typed one. They are not worth rediscovering per form, which
 * is the whole reason this is a hook and not a pattern to copy.
 *
 *   - A slot is whatever the form calls a row. The ledger keys by expense
 *     index; the shifts sheet keys by shift-and-invoice. Neither is this
 *     module's business, so a slot is just a string.
 *   - An upload registers itself as pending. `awaitPending` before saving,
 *     or a quick save posts a row whose key has not arrived yet.
 *   - A scan NEVER writes a field itself. It hands the result to the form
 *     through `onScanned`, which fills only what is still empty. The person
 *     holding the receipt outranks the model.
 *   - Object URLs pin their file in memory until revoked, so they are
 *     released when a photo is replaced or removed and on unmount.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  UploadError,
  scanUploaded,
  uploadPhoto,
  type ScannedReceipt,
} from './receiptUpload';
import { PdfError, isPdf, pdfToPages } from './pdfPages';
import {
  MSG_DATE_FIRST,
  MSG_PHOTO_BLOCKED,
  MSG_PHOTO_FAILED,
  MSG_PHOTO_NOT_ALLOWED,
  MSG_PHOTO_NOT_CONFIGURED,
  MSG_PHOTO_REJECTED,
  MSG_PHOTO_HEIC,
  MSG_PHOTO_RAW,
  MSG_PHOTO_UNREADABLE,
} from '../lib/messages';
import {
  MSG_PDF_NO_ROOM,
  MSG_PDF_TOO_MANY,
  MSG_PDF_UNREADABLE,
} from '../lib/messages';

/**
 * Names the stage that failed. The first version said only "the photo was
 * not sent" for every cause, which told the person at the till nothing and
 * cost a long evening of guessing at the storage end.
 */
export function photoFailureMessage(error: unknown): string {
  if (!(error instanceof UploadError)) return MSG_PHOTO_FAILED;
  switch (error.reason) {
    case 'storage_not_configured':
      return MSG_PHOTO_NOT_CONFIGURED;
    case 'not_authorised':
      return MSG_PHOTO_NOT_ALLOWED;
    case 'blocked':
      return MSG_PHOTO_BLOCKED;
    case 'rejected':
      return MSG_PHOTO_REJECTED;
    case 'compression_failed':
      return MSG_PHOTO_UNREADABLE;
    case 'heic_unsupported':
      return MSG_PHOTO_HEIC;
    case 'raw_unsupported':
      return MSG_PHOTO_RAW;
    default:
      return MSG_PHOTO_FAILED;
  }
}

export interface ReceiptPhotoState {
  name: string;
  /**
   * An object URL for the LOCAL file, shown as a thumbnail. Not the stored
   * object: the bucket is private, so displaying that would mean signing a
   * read url per row for a picture the browser already holds.
   */
  previewUrl?: string;
  status: 'uploading' | 'uploaded' | 'scanning' | 'failed';
  /**
   * What the scan actually wrote into the form, in the person's words, so
   * the row can say "ALPHAMEGA · 163704 · 01/08/2026" rather than the
   * uninformative "filled from the photo".
   */
  filled?: string[];
  /**
   * The amount came from the photo. Saving is blocked until `checked`.
   *
   * This deliberately does NOT depend on the model's own confidence. That
   * was the first design, and it failed in use: a wrong amount came back
   * marked "high" and sailed through unflagged. A self-reported certainty
   * is not evidence, so every machine-read amount is now confirmed by a
   * person — which is one tap, against a wrong figure entering a cash
   * reconciliation looking authoritative.
   */
  needsCheck?: boolean;
  checked?: boolean;
  /**
   * Where the figure came from, e.g. «Total EURO» → 49,92. Without this
   * the tick is a reflex; with it there is one line to look at.
   */
  checkHint?: string;
  /**
   * The scan ran and came back without a usable amount, and the field is
   * still empty.
   *
   * Refusing to guess is the correct behaviour, but refusing SILENTLY is
   * not: the person sees a photo attached, no amount, and no explanation,
   * and cannot tell whether the scan failed, is still running, or decided
   * against answering. It does not block the save — there is nothing to
   * verify, only something to type.
   */
  unread?: string[];
  /** The R2 object key. Absent until the upload succeeds. */
  key?: string;
  /** Set when a field was filled from the photo rather than typed. */
  scanned?: 'high' | 'low';
  message?: string;
}

/** What the form did with a scan, reported back so the hook can judge it. */
export interface ScanFill {
  /** Whether the AMOUNT was filled. Other fields do not gate a save. */
  amount: boolean;
  /** Labels of everything filled, for the row's summary. */
  fields: string[];
  /** What to show beside the tick, e.g. «Total EURO» → 49,92. */
  hint?: string;
  /** Fields the scan could not supply and which are still blank. */
  unread?: string[];
}

export interface UseReceiptPhotos {
  photos: Record<string, ReceiptPhotoState>;
  /** Attach a file to a slot. Registers itself as pending; never throws. */
  attach: (slot: string, file: File | null) => void;
  /** Forget the photo on a slot. The stored object is left alone. */
  remove: (slot: string) => void;
  /**
   * The stored key for a slot, or ''. Read from a ref, NOT from state, so
   * it is correct when called after `awaitPending` — see the note on
   * `keys` below. Use `photos[slot]` for rendering; use this for saving.
   */
  keyFor: (slot: string) => string;
  /** Call before building a save payload. */
  awaitPending: () => Promise<void>;
  registerInput: (slot: string, el: HTMLInputElement | null) => void;
  /** The person has looked at the receipt for this slot. */
  acknowledge: (slot: string) => void;
  /**
   * Slots whose low-confidence amount has not been checked yet. Read from
   * a ref for the same reason keyFor is — it is called after an await.
   */
  pendingChecks: () => string[];
}

export function useReceiptPhotos(options: {
  restaurantId: string;
  businessDate: string;
  onScanned?: (slot: string, scan: ScannedReceipt) => ScanFill | void;
  /**
   * The fields on this row that are still blank, in the person's words.
   * Used when no scan came back at all — the form knows its own fields,
   * this hook does not.
   */
  blankFields?: (slot: string) => string[];
  /**
   * Which lines the pages of a scanned PDF should land on, starting with
   * the one that was clicked. The form returns as many as it can make;
   * returning fewer than asked is reported to the person, not ignored.
   */
  slotsForPages?: (firstSlot: string, pageCount: number) => string[];
  /**
   * The photo on this slot has been removed. The form uses it to take back
   * what the scan wrote — values that came from a picture nobody is
   * keeping should not outlive it, and leaving them behind is worse than
   * useless: they look typed.
   */
  onRemoved?: (slot: string) => void;
}): UseReceiptPhotos {
  const [photos, setPhotos] = useState<Record<string, ReceiptPhotoState>>({});

  // Read through refs so an upload started before the person changed the
  // date still posts against the date that was on screen when they picked
  // the file, and so `attach` does not need rebuilding on every keystroke.
  const opts = useRef(options);
  opts.current = options;

  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const previews = useRef<Record<string, string>>({});
  const pending = useRef<Set<Promise<void>>>(new Set());
  /**
   * The object keys, mirrored outside React state.
   *
   * This is not a micro-optimisation, it is the only correct place to read
   * them from. `handleSave` awaits the in-flight uploads and then builds
   * the payload — but a closure created in an earlier render still holds
   * that render's `photos` object, and an upload finishing does not change
   * it. Reading state there yields the value from BEFORE the upload, so
   * the key is lost in precisely the race the await exists to close.
   * Writing the key here the moment it arrives is synchronous and has no
   * such hole.
   */
  const keys = useRef<Record<string, string>>({});
  /** Mirrored outside state, for the same after-await reason as `keys`. */
  const checks = useRef<Record<string, { needs: boolean; checked: boolean }>>({});

  const releasePreview = useCallback((slot: string) => {
    const url = previews.current[slot];
    if (url) {
      URL.revokeObjectURL(url);
      delete previews.current[slot];
    }
  }, []);

  useEffect(
    () => () => {
      for (const url of Object.values(previews.current)) URL.revokeObjectURL(url);
      previews.current = {};
    },
    []
  );

  const run = useCallback(
    async (slot: string, file: File): Promise<void> => {
      const { restaurantId, businessDate, onScanned } = opts.current;

      if (!businessDate) {
        setPhotos((p) => ({
          ...p,
          [slot]: { name: file.name, status: 'failed', message: MSG_DATE_FIRST },
        }));
        return;
      }

      releasePreview(slot);
      delete keys.current[slot];
      delete checks.current[slot];
      const previewUrl = URL.createObjectURL(file);
      previews.current[slot] = previewUrl;
      setPhotos((p) => ({ ...p, [slot]: { name: file.name, previewUrl, status: 'uploading' } }));

      let key: string;
      try {
        ({ key } = await uploadPhoto(file, restaurantId, businessDate));
      } catch (error) {
        // The console line is for whoever is debugging; the Greek is for
        // whoever is standing at the till. Both are needed.
        console.error('[zet] receipt upload failed', error);
        setPhotos((p) => ({
          ...p,
          [slot]: {
            name: file.name,
            previewUrl,
            status: 'failed',
            message: photoFailureMessage(error),
          },
        }));
        return;
      }

      keys.current[slot] = key;
      setPhotos((p) => ({
        ...p,
        [slot]: { name: file.name, previewUrl, status: 'scanning', key },
      }));

      const scan = await scanUploaded(key, restaurantId, businessDate);

      // The form fills the fields and tells us what it filled. It, not
      // this hook, knows which of its fields were already typed in — and a
      // scanned value never overwrites a typed one.
      const fill = scan ? onScanned?.(slot, scan) : undefined;
      const amountFilled = fill?.amount === true;

      // Covers both a scan that declined to name an amount and one that
      // never happened (no key, or the call failed). From where the person
      // is standing those are the same event: the photo is attached and
      // the amount is still blank.
      const unread = scan ? (fill?.unread ?? []) : (opts.current.blankFields?.(slot) ?? []);

      // Any machine-read AMOUNT needs a person's eye, whatever the model
      // said about its own certainty — see the note on needsCheck. Other
      // fields do not gate the save: a shaky supplier name is worth
      // showing, and not worth stopping a 1am close for.
      const needsCheck = amountFilled;
      checks.current[slot] = { needs: needsCheck, checked: false };

      setPhotos((p) => ({
        ...p,
        [slot]: {
          name: file.name,
          previewUrl,
          status: 'uploaded',
          key,
          scanned: amountFilled ? scan?.confidence : undefined,
          filled: fill?.fields?.length ? fill.fields : undefined,
          needsCheck: needsCheck || undefined,
          checkHint: fill?.hint,
          unread: unread.length > 0 ? unread : undefined,
          checked: false,
        },
      }));
    },
    [releasePreview]
  );

  /**
   * A scanned PDF holds a whole day of receipts, so every page is
   * attached to its own line. The FORM decides which lines those are —
   * it owns its numbering and can make more — and this only asks.
   *
   * If it comes back with fewer lines than there are pages, the extra
   * pages are reported, never dropped in silence. A receipt that
   * disappears without a word is the failure this whole path exists to
   * avoid.
   */
  const attachPdf = useCallback(
    async (slot: string, file: File): Promise<void> => {
      setPhotos((p) => ({ ...p, [slot]: { name: file.name, status: 'uploading' } }));

      let pages;
      try {
        pages = await pdfToPages(file);
      } catch (cause) {
        const message =
          cause instanceof PdfError && cause.reason === 'too_many_pages'
            ? MSG_PDF_TOO_MANY(cause.pageCount ?? 0)
            : MSG_PDF_UNREADABLE;
        setPhotos((p) => ({ ...p, [slot]: { name: file.name, status: 'failed', message } }));
        return;
      }

      const slots = opts.current.slotsForPages?.(slot, pages.length) ?? [slot];
      const usable = Math.min(slots.length, pages.length);

      for (let i = 0; i < usable; i += 1) {
        const page = pages[i]!;
        const pageFile = new File(
          [page.blob],
          // Named by page so the archive and the line both say which one.
          `${file.name.replace(/\.pdf$/i, '')} — σελ. ${page.pageNumber}.jpg`,
          { type: 'image/jpeg' }
        );
        await run(slots[i]!, pageFile);
      }

      if (usable < pages.length) {
        setPhotos((p) => ({
          ...p,
          [slot]: {
            ...(p[slot] ?? { name: file.name, status: 'failed' as const }),
            message: MSG_PDF_NO_ROOM(usable, pages.length),
          },
        }));
      }
    },
    [run]
  );

  const attach = useCallback(
    (slot: string, file: File | null) => {
      if (!file) return;
      const work = isPdf(file) ? attachPdf(slot, file) : run(slot, file);
      pending.current.add(work);
      void work.finally(() => pending.current.delete(work));
    },
    [run, attachPdf]
  );

  const remove = useCallback(
    (slot: string) => {
      opts.current.onRemoved?.(slot);
      releasePreview(slot);
      delete keys.current[slot];
      delete checks.current[slot];
      setPhotos((p) => {
        const next = { ...p };
        delete next[slot];
        return next;
      });
      // Clearing the input matters: without it, picking the same file again
      // fires no change event and the photo cannot be re-attached.
      const input = inputs.current[slot];
      if (input) input.value = '';
    },
    [releasePreview]
  );

  const awaitPending = useCallback(async () => {
    if (pending.current.size === 0) return;
    await Promise.allSettled([...pending.current]);
  }, []);

  const keyFor = useCallback((slot: string) => keys.current[slot] ?? '', []);

  const registerInput = useCallback((slot: string, el: HTMLInputElement | null) => {
    inputs.current[slot] = el;
  }, []);

  const acknowledge = useCallback((slot: string) => {
    const c = checks.current[slot];
    if (c) c.checked = true;
    setPhotos((p) => (p[slot] ? { ...p, [slot]: { ...p[slot], checked: true } } : p));
  }, []);

  const pendingChecks = useCallback(
    () =>
      Object.entries(checks.current)
        .filter(([, c]) => c.needs && !c.checked)
        .map(([slot]) => slot),
    []
  );

  return {
    photos,
    attach,
    remove,
    keyFor,
    awaitPending,
    registerInput,
    acknowledge,
    pendingChecks,
  };
}
