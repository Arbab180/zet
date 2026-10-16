/**
 * Browser-side receipt handling: shrink the photo, then PUT it straight to
 * R2 on a signed URL, then ask the server to read the amount off it.
 *
 * ── Why the shrink is load-bearing ──────────────────────────────────────
 *
 * A phone photo is 3–5MB. Shrunk it is a small fraction of that, which is
 * the difference between R2's free 10GB holding tens of thousands of
 * receipts and holding a couple of thousand, and it roughly halves what
 * each scan costs, since the model is billed by image area.
 *
 * ── Why it sizes by the SHORT edge ──────────────────────────────────────
 *
 * The first version capped the LONGEST edge at 1600px. That is right for a
 * photo and wrong for a receipt. Receipts are not one shape: a thermal till
 * roll is narrow and very long, an A4 supplier invoice is not. Capping the
 * long edge of a 1000x4000 till roll produces 400x1600 — about ten pixels
 * per character across. Unreadable to the scanner AND to a person opening
 * the archive later, which is the worse loss of the two, because the stored
 * photo is the evidence.
 *
 * Text legibility follows the SHORT edge, since that is the direction the
 * text runs across. So the short edge is what gets the target, and a pixel
 * budget bounds the file for extreme shapes. A normal 4:3 phone photo comes
 * out at exactly the size it did before; a long receipt simply keeps more
 * of itself.
 *
 * If compression fails, this FAILS rather than quietly uploading the
 * original. A silent fallback would blow through the storage budget and
 * the scan cost while appearing to work perfectly.
 */

/**
 * Enough width for the text on a receipt to survive. Chosen so a 4:3 phone
 * photo lands on the same 1200x1600 it did when this capped the long edge
 * at 1600 — no change for the common case, no extra storage for it either.
 */
export const SHORT_EDGE_TARGET_PX = 1200;

/**
 * The ceiling that stops a very long receipt from becoming a very large
 * file. Only a shape past roughly 1:5 ever reaches it.
 */
export const MAX_PIXELS = 6_000_000;

/**
 * The API refuses an image whose width or height exceeds 8000px, and a
 * pixel BUDGET alone does not prevent that: 900x20000 satisfies six
 * megapixels at 520x11538 and is still far too long. Bounding the area
 * without bounding the edge is how a pathological photo gets uploaded,
 * stored, and then rejected at scan time with nothing to show for it.
 */
export const MAX_EDGE_PX = 8000;

/** Kept for the scan cost as much as the file size. */
export const JPEG_QUALITY = 0.8;

/**
 * Tried in order when the encoded photo overruns the byte budget. Dropping
 * quality is far kinder to small text than dropping pixels.
 */
const FALLBACK_QUALITIES = [0.65, 0.5] as const;

/** Server-side limit in src/server/storage.ts, repeated here to fail early. */
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export interface PreparedPhoto {
  blob: Blob;
  contentType: 'image/jpeg';
  originalBytes: number;
}

/**
 * The output size for an image of w x h. Pure, so the rules above are
 * testable without a canvas — which is the only part of this file that can
 * be tested at all in a project with no DOM test setup.
 *
 * Never upscales: a small or already-modest photo is passed through at its
 * own size rather than interpolated into looking sharper than it is.
 */
export function fitDimensions(
  width: number,
  height: number
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error('image has no usable dimensions');
  }

  const shortEdge = Math.min(width, height);
  // min(1, ...) is what makes this never upscale.
  let scale = Math.min(1, SHORT_EDGE_TARGET_PX / shortEdge);

  // A long receipt can satisfy the short edge and still be enormous. Pull
  // the whole thing down together so the aspect ratio is untouched.
  const pixels = width * scale * (height * scale);
  if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);

  // Independently of area: nothing may exceed the longest edge the API
  // will accept.
  const longEdge = Math.max(width, height) * scale;
  if (longEdge > MAX_EDGE_PX) scale *= MAX_EDGE_PX / longEdge;

  let w = Math.max(1, Math.round(width * scale));
  let h = Math.max(1, Math.round(height * scale));

  // Rounding up can push the result just past the ceiling — 1200x12000
  // lands 3,150 pixels over it. Trimming the long edge costs nothing
  // visible and means MAX_PIXELS is a limit rather than an aspiration.
  while ((w * h > MAX_PIXELS || w > MAX_EDGE_PX || h > MAX_EDGE_PX) && (w > 1 || h > 1)) {
    if (w >= h) w -= 1;
    else h -= 1;
  }

  return { width: w, height: h };
}

/**
 * Canvas to JPEG, under the byte cap, dropping quality before giving up.
 *
 * Shared with the PDF path so a scanned page is held to exactly the same
 * limits as a photographed one. A second copy of this ladder would drift
 * from this one, and the drift would show up as receipts that upload from
 * the camera and fail from the scanner for no reason anyone could see.
 */
export async function encodeCanvas(
  canvas: HTMLCanvasElement,
  /**
   * The PDF path passes a higher quality than the final one. Its pages
   * go back through compressPhoto on their way to R2, so they are
   * encoded twice, and JPEG loses a little more each generation —
   * exactly on the small text these receipts exist to preserve. Starting
   * the intermediate higher costs some transient memory and nothing
   * else.
   */
  startQuality: number = JPEG_QUALITY
): Promise<Blob> {
  const encode = (quality: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

  let blob = await encode(startQuality);
  for (const quality of FALLBACK_QUALITIES) {
    if (blob && blob.size <= MAX_PHOTO_BYTES) break;
    blob = await encode(quality);
  }
  if (!blob) throw new Error('compression produced nothing');
  if (blob.size > MAX_PHOTO_BYTES) {
    throw new Error(`photo is still ${Math.round(blob.size / 1024)}KB after compression`);
  }
  return blob;
}

/** A white canvas of the given size. JPEG has no alpha, and a transparent
 *  edge would otherwise encode as black and eat into the page. */
export function blankCanvas(width: number, height: number): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  return { canvas, ctx };
}

export async function compressPhoto(file: File): Promise<PreparedPhoto> {
  // Explicit, not defaulted. A phone writes the rotation into EXIF rather
  // than the pixels, and browsers have disagreed about whether an
  // ImageBitmap honours it. Left to chance, a receipt reaches the archive
  // on its side — unreadable to the scanner and annoying to a person.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const { width, height } = fitDimensions(bitmap.width, bitmap.height);

    const { canvas, ctx } = blankCanvas(width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await encodeCanvas(canvas);
    return { blob, contentType: 'image/jpeg', originalBytes: file.size };
  } finally {
    bitmap.close();
  }
}

export type UploadFailure =
  | 'storage_not_configured'
  | 'not_authorised'
  | 'signing_failed'
  | 'blocked'
  | 'rejected'
  | 'compression_failed'
  | 'heic_unsupported'
  | 'raw_unsupported';

/**
 * Apple's photo format. Every iPhone since 2017 shoots it by default, and
 * no browser but Safari can decode it, so a photo PICKED from the library
 * on a Mac or an Android browser arrives unreadable.
 *
 * Checked by extension as well as type: a file dragged in from Finder, or
 * handed over by an older browser, often arrives with an empty type.
 */
export function looksHeic(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === 'image/heic' || type === 'image/heif') return true;
  return (type === '' || type === 'application/octet-stream') && /\.hei[cf]$/i.test(file.name);
}

/**
 * Camera RAW: DNG (a phone shooting RAW/ProRAW, or Adobe's format) and the
 * camera makers' own. No browser decodes any of them. By extension only —
 * browsers report these with an empty or generic type.
 */
export function looksRaw(file: File): boolean {
  return /\.(dng|cr2|cr3|nef|arw|raf|orf|rw2)$/i.test(file.name);
}

/**
 * Carries WHICH step failed. The first version reported every failure as
 * "the photo was not sent", which is true and useless: a missing bucket
 * rule, an expired session and a browser that cannot read the file all
 * looked identical, including to whoever had to debug it.
 */
export class UploadError extends Error {
  constructor(
    readonly reason: UploadFailure,
    message: string
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

export interface UploadedPhoto {
  key: string;
  bytes: number;
}

export async function uploadPhoto(
  file: File,
  restaurantId: string,
  businessDate: string
): Promise<UploadedPhoto> {
  let prepared: PreparedPhoto;
  try {
    prepared = await compressPhoto(file);
  } catch (cause) {
    // Naming HEIC specifically, because the advice differs. "Try again" is
    // useless for a format this browser will never read — it needs the
    // camera button, or the phone set to Most Compatible. Every other
    // failure here genuinely is worth retrying.
    //
    // Decided by attempt, not by the file alone: Safari decodes HEIC
    // perfectly well, and refusing it up front would break the one browser
    // where it works.
    if (looksHeic(file)) {
      throw new UploadError('heic_unsupported', `HEIC not decodable here: ${String(cause)}`);
    }
    if (looksRaw(file)) {
      throw new UploadError('raw_unsupported', `RAW not decodable in a browser: ${String(cause)}`);
    }
    throw new UploadError('compression_failed', `could not read the image: ${String(cause)}`);
  }

  const urlResponse = await fetch('/api/receipts/upload-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ restaurantId, businessDate, contentType: prepared.contentType }),
  });
  if (!urlResponse.ok) {
    const detail = await urlResponse.text().catch(() => '');
    throw new UploadError(
      urlResponse.status === 503
        ? 'storage_not_configured'
        : urlResponse.status === 401 || urlResponse.status === 403
          ? 'not_authorised'
          : 'signing_failed',
      `upload-url ${urlResponse.status} ${detail}`.trim()
    );
  }
  const { key, url } = (await urlResponse.json()) as { key: string; url: string };

  // Straight to R2. The content type must match what the URL was signed
  // for, or R2 rejects it.
  let put: Response;
  try {
    put = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': prepared.contentType },
      body: prepared.blob,
    });
  } catch (cause) {
    // A cross-origin PUT that the browser blocks throws here rather than
    // returning a status — fetch cannot see a response it was not allowed
    // to read. In practice this is almost always a missing CORS rule on
    // the bucket, which is invisible from the server side.
    throw new UploadError('blocked', `PUT to storage blocked: ${String(cause)}`);
  }
  if (!put.ok) {
    throw new UploadError('rejected', `storage rejected the upload (${put.status})`);
  }

  return { key, bytes: prepared.blob.size };
}

export interface ScannedReceipt {
  totalCents: number | null;
  /** The words printed beside the figure, for checking it quickly. */
  totalLabel: string | null;
  supplier: string | null;
  invoiceNumber: string | null;
  date: string | null;
  confidence: 'high' | 'low';
  /**
   * The lines on the receipt. Optional because a page still open from
   * before this shipped can be answered by a newer server, and the other
   * way round during a rollout — absent simply means "none read".
   */
  items?: Array<{ name: string; qty: string; amountCents: number | null }>;
}

/**
 * Null when scanning is unavailable or the receipt could not be read. The
 * photo is still uploaded and attached either way — the amount is simply
 * typed by hand, as it is today.
 */
export async function scanUploaded(
  key: string,
  restaurantId: string,
  businessDate: string
): Promise<ScannedReceipt | null> {
  const response = await fetch('/api/receipts/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ restaurantId, businessDate, key }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { result?: ScannedReceipt };
  return body.result ?? null;
}
