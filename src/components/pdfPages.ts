/**
 * A scanned PDF, turned into one JPEG per page.
 *
 * ── Why every page, not the first ──────────────────────────────────────
 *
 * The scanner is used for a whole day at once: one file holding the day's
 * receipts. Attaching page one to an invoice line and stopping would file
 * one receipt and silently drop the rest — real money, quietly gone, on
 * the one path where nobody would think to check. Every page comes back,
 * and the caller spreads them across the invoice lines.
 *
 * ── Why rasterise at all ───────────────────────────────────────────────
 *
 * The scan API reads PDFs directly, so this is not strictly necessary.
 * Rendering here buys three things that path does not: the same size
 * discipline photos already get, one stored format so the archive's
 * thumbnails keep working, and a page count the form can act on. These
 * PDFs come off a scanner, so their pages ARE images — there is no text
 * layer being thrown away.
 */

import {
  SHORT_EDGE_TARGET_PX,
  blankCanvas,
  encodeCanvas,
  fitDimensions,
} from './receiptUpload';

/**
 * A bound, not a target. A misfed scanner producing a 300-page file
 * should be refused with an explanation, not turned into 300 uploads and
 * 300 scan calls that nobody asked for and someone pays for.
 */
export const MAX_PDF_PAGES = 25;

/** Higher than the final upload quality on purpose — see encodeCanvas. */
const PAGE_QUALITY = 0.92;

export interface PdfPage {
  /** 1-based, as the person reading the scanner sees it. */
  pageNumber: number;
  blob: Blob;
}

export class PdfError extends Error {
  constructor(
    readonly reason: 'too_many_pages' | 'unreadable' | 'empty',
    message: string,
    readonly pageCount?: number
  ) {
    super(message);
    this.name = 'PdfError';
  }
}

export function isPdf(file: File): boolean {
  // Type first, extension only as a fallback: some scanners and some
  // older browsers hand over an empty type for a perfectly good file.
  if (file.type === 'application/pdf') return true;
  return file.type === '' && /\.pdf$/i.test(file.name);
}

/**
 * Rendered at whatever scale puts the page's SHORT edge on the same
 * target a photograph gets, then passed through fitDimensions so the
 * area and long-edge ceilings apply identically.
 *
 * Rendering at scale 1 and shrinking afterwards would throw away detail
 * before the JPEG encoder ever saw it: a PDF page has no fixed pixel
 * size, so scale 1 is 72dpi — about 600px across an A4 page, which is
 * roughly half of what the text needs to survive.
 */
export async function pdfToPages(file: File): Promise<PdfPage[]> {
  const pdfjs = await import('pdfjs-dist');
  // Bundled as a module worker rather than fetched from a CDN: this app
  // has to keep working on a restaurant's wifi, and an unreachable CDN
  // would fail the upload with nothing useful to say.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url
  ).toString();

  // The LOADING TASK owns the worker, and destroying it is what releases
  // the worker thread. Releasing only the document leaks one worker per
  // PDF opened, which on a day of scanning is a tab that slows to a crawl
  // for no reason anyone could connect to attaching a receipt.
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  let doc;
  try {
    doc = await task.promise;
  } catch (cause) {
    await task.destroy();
    throw new PdfError('unreadable', `could not open the PDF: ${String(cause)}`);
  }

  try {
    if (doc.numPages < 1) throw new PdfError('empty', 'the PDF has no pages');
    if (doc.numPages > MAX_PDF_PAGES) {
      throw new PdfError(
        'too_many_pages',
        `the PDF has ${doc.numPages} pages`,
        doc.numPages
      );
    }

    const pages: PdfPage[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const unscaled = page.getViewport({ scale: 1 });
      const shortEdge = Math.min(unscaled.width, unscaled.height);
      const scale = shortEdge > 0 ? SHORT_EDGE_TARGET_PX / shortEdge : 1;
      const viewport = page.getViewport({ scale });

      const { width, height } = fitDimensions(viewport.width, viewport.height);
      const { canvas, ctx } = blankCanvas(width, height);
      // The viewport may differ from the clamped size by a pixel or two
      // after fitDimensions; render into the canvas we actually made.
      await page.render({
        canvas,
        canvasContext: ctx,
        viewport: page.getViewport({ scale: scale * (width / viewport.width) }),
      }).promise;

      pages.push({ pageNumber: n, blob: await encodeCanvas(canvas, PAGE_QUALITY) });
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
