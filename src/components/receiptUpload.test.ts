/**
 * The sizing rules for receipt photos.
 *
 * Only the arithmetic is testable here — compressPhoto itself needs a
 * canvas and this project has no DOM test setup — but the arithmetic is
 * where the damage was. Capping the longest edge quietly destroyed exactly
 * the receipts the business has most of: long thermal till rolls.
 */
import { describe, expect, it } from 'vitest';
import { MAX_EDGE_PX, MAX_PIXELS, SHORT_EDGE_TARGET_PX, fitDimensions, looksRaw } from './receiptUpload';

const ratio = (w: number, h: number) => w / h;

describe('fitDimensions', () => {
  it('leaves an ordinary 4:3 phone photo where the old rule put it', () => {
    // The whole point of the 1200 target: no regression, and no extra
    // storage, for the shape most photos actually are.
    expect(fitDimensions(3024, 4032)).toEqual({ width: 1200, height: 1600 });
  });

  it('keeps a long till roll readable instead of squashing it to 400px', () => {
    const out = fitDimensions(1000, 4000);
    // The old rule scaled the LONG edge to 1600, giving 400x1600 — about
    // ten pixels per character across, which no one and nothing can read.
    expect(out.width).toBeGreaterThan(400);
    expect(out.width).toBe(1000);
    expect(out.height).toBe(4000);
  });

  it('never upscales a photo that is already small', () => {
    expect(fitDimensions(640, 480)).toEqual({ width: 640, height: 480 });
    expect(fitDimensions(300, 900)).toEqual({ width: 300, height: 900 });
  });

  it('gives the short edge the target when the photo is big enough', () => {
    expect(fitDimensions(2400, 9600).width).toBe(SHORT_EDGE_TARGET_PX);
  });

  it('bounds an extreme shape by total pixels rather than letting it explode', () => {
    const out = fitDimensions(1200, 12000);
    expect(out.width * out.height).toBeLessThanOrEqual(MAX_PIXELS);
    // Degraded, but deliberately, and still far better than 160px across.
    expect(out.width).toBeGreaterThan(700);
  });

  it('never exceeds the longest edge the API will accept', () => {
    // A pixel budget alone does not catch this: 900x20000 satisfies six
    // megapixels at 520x11538 and is still 11538px long, which the API
    // refuses outright. Uploaded and stored, then rejected at scan time.
    const out = fitDimensions(900, 20000);
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(MAX_EDGE_PX);
    expect(out.width * out.height).toBeLessThanOrEqual(MAX_PIXELS);
  });

  it('never changes the aspect ratio, whatever the shape', () => {
    for (const [w, h] of [
      [3024, 4032],
      [4032, 3024],
      [1000, 4000],
      [1200, 12000],
      [2400, 2400],
      [5000, 1000],
    ] as const) {
      const out = fitDimensions(w, h);
      // Rounding to whole pixels moves it very slightly; anything more
      // means the receipt is being stretched.
      expect(ratio(out.width, out.height)).toBeCloseTo(ratio(w, h), 2);
    }
  });

  it('treats a wide invoice the same as a tall one', () => {
    const tall = fitDimensions(1000, 4000);
    const wide = fitDimensions(4000, 1000);
    expect(wide).toEqual({ width: tall.height, height: tall.width });
  });

  it('refuses dimensions that cannot describe an image', () => {
    expect(() => fitDimensions(0, 100)).toThrow();
    expect(() => fitDimensions(100, Number.NaN)).toThrow();
  });
});

describe('looksRaw', () => {
  const named = (name: string) => ({ name, type: '' }) as File;

  it('recognises camera RAW files by their ending, in either case', () => {
    expect(looksRaw(named('IMG_0412.DNG'))).toBe(true);
    expect(looksRaw(named('receipt.dng'))).toBe(true);
    expect(looksRaw(named('DSC001.ARW'))).toBe(true);
  });

  it('leaves ordinary photos and PDFs alone', () => {
    expect(looksRaw(named('receipt.jpg'))).toBe(false);
    expect(looksRaw(named('scan.pdf'))).toBe(false);
    expect(looksRaw(named('dng-notes.png'))).toBe(false);
  });
});
