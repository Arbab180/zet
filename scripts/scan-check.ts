/**
 * Checks that the receipt scanner's key and model actually work.
 *
 *   npm run scan:check            # blank test image
 *   npm run scan:check photo.jpg  # a real receipt
 *
 * Run it in your own Terminal — it needs internet.
 *
 * The point is to separate two things that both surface in the app as "no
 * amount appeared": a broken key or model, and a receipt the model could
 * not read. Those have completely different fixes, and guessing between
 * them by photographing receipts is slow. This calls the real scanReceipt,
 * so what it exercises is the code the app runs, not an imitation of it.
 *
 * With no argument it sends a blank 1x1 image. The CORRECT result there is
 * no amount: the scanner is built to refuse rather than guess. Seeing that
 * proves the key, the model, the request shape and the refusal logic all
 * work, without needing a receipt to hand.
 */

import { readFile } from 'node:fs/promises';
import { parseCents } from '../src/lib/money.ts';
import { DEFAULT_SCAN_MODEL, readScanConfig, scanReceipt } from '../src/server/scan.ts';

const BLANK_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);

const config = readScanConfig();
if (!config) {
  console.error('\nANTHROPIC_API_KEY is not set in .env.local. Scanning is off;');
  console.error('photos still upload and amounts are typed by hand.\n');
  process.exit(1);
}

console.log(`\nmodel: ${config.model}${config.model === DEFAULT_SCAN_MODEL ? '  (default)' : '  (from ANTHROPIC_SCAN_MODEL)'}`);

// Below 4.7 the API caps an image at 1568px on its long edge instead of
// 2576px, and a receipt is mostly small print.
const version = /-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(config.model.replace(/^claude-[a-z]+/, ''));
if (version) {
  const major = Number(version[1]);
  const minor = Number(version[2] ?? 0);
  if (major < 4 || (major === 4 && minor < 7)) {
    console.log('  ⚠ this model is older than 4.7, so images are capped at 1568px');
    console.log('    rather than 2576px. Small print on receipts will suffer.');
  }
}

const path = process.argv[2];
let image: Buffer;
let mediaType: string;

if (path) {
  try {
    image = await readFile(path);
  } catch {
    // A stack trace for a typo'd path is noise. The useful reply names
    // the trick that gets the path right every time.
    console.error(`\n  ✗ no file at ${path}\n`);
    console.error('    Drag the receipt from Finder onto the Terminal window —');
    console.error('    that pastes its exact path, spaces and all.\n');
    console.error('    Or copy it into the project, where Claude can see it too:');
    console.error('      cp <the receipt> ~/zet/receipts-test/\n');
    process.exit(1);
  }
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
    console.error(`\n  ✗ ${ext || 'that file'} is not an image the API reads.`);
    console.error('    Use a .jpg, .png or .webp. An iPhone .heic needs converting:');
    console.error(`      sips -s format jpeg "${path}" --out receipt.jpg\n`);
    process.exit(1);
  }
  mediaType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const kb = Math.round(image.length / 1024);
  console.log(`image: ${path}  (${kb}KB, ${mediaType})`);
  if (image.length > 5 * 1024 * 1024) {
    console.log('  ⚠ over 5MB. The app compresses before uploading, so this is');
    console.log('    larger than anything the scanner sees in normal use.');
  }
} else {
  image = BLANK_JPEG;
  mediaType = 'image/jpeg';
  console.log('image: a blank 1x1 test image — no amount is the CORRECT result');
}

console.log('\ncalling the API…');
const started = Date.now();
const outcome = await scanReceipt(image, mediaType, parseCents);
const seconds = ((Date.now() - started) / 1000).toFixed(1);

if (!outcome.ok) {
  console.error(`\n  ✗ ${outcome.error} after ${seconds}s`);
  console.error(`    ${outcome.message}`);
  const advice: Record<string, string> = {
    not_configured: 'ANTHROPIC_API_KEY is empty.',
    unreadable: 'The model answered but could not read the image. The key and\n    model are fine — this is a photo problem.',
    upstream:
      'The API refused the call. Usually one of: the key is wrong or revoked,\n' +
      '    the model id does not exist, or the account has no credit. The server\n' +
      '    log line above names which.',
  };
  console.error(`\n    ${advice[outcome.error] ?? ''}\n`);
  process.exit(1);
}

const r = outcome.result;
console.log(`\n  ✓ the model answered in ${seconds}s\n`);
console.log(`    total       ${r.totalCents == null ? 'null' : `${(r.totalCents / 100).toFixed(2)}  (${r.totalCents} cents)`}`);
console.log(`    supplier    ${r.supplier ?? 'null'}`);
console.log(`    invoice no  ${r.invoiceNumber ?? 'null'}`);
console.log(`    date        ${r.date ?? 'null'}`);
console.log(`    confidence  ${r.confidence}`);

if (!path) {
  console.log(
    r.totalCents == null
      ? '\n  ✓ No amount from a blank image — correct. The key, the model and\n    the refusal logic all work. Photograph a real receipt next.\n'
      : '\n  ⚠ It returned an amount for a BLANK image. That is the one failure\n    that matters: the scanner is meant to refuse rather than guess, and\n    a number invented here would reach a cash reconciliation looking\n    authoritative. Worth investigating before trusting it.\n'
  );
} else {
  console.log('\n  Compare each line against the receipt itself. A wrong number is worse\n  than a null, because nobody re-reads a figure that filled itself in.\n');
}
