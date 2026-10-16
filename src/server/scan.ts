/**
 * Reading an amount off a photographed receipt.
 *
 * Calls the Anthropic API with plain fetch — no SDK. This makes one request
 * with one shape; a client library would add a dependency, a release
 * cadence and a surface area in exchange for nothing needed here.
 *
 * ── The key never reaches the browser ───────────────────────────────────
 *
 * ANTHROPIC_API_KEY is read here, on the server, and the photo is fetched
 * from R2 server-side. The prototype called the model from the page, which
 * spent each viewer's own Claude usage — never viable for staff at a till,
 * and it would have put a billable key in every browser.
 *
 * ── A scanned figure is a suggestion, not a record ──────────────────────
 *
 * `total` is null unless the model is sure. A number that flows silently
 * into a cash reconciliation is worse than no number, because it looks
 * authoritative and nobody re-reads it. The caller shows it as editable and
 * visibly provisional; this module's job is to refuse to guess.
 */

export interface ScanResult {
  totalCents: number | null;
  /**
   * The words printed beside the figure, so the person can check one line
   * rather than re-read the receipt. Self-reported confidence turned out
   * not to be trustworthy — a wrong amount came back marked "high" — so
   * what the UI needs is not a claim about certainty but a pointer to
   * where the number came from.
   */
  totalLabel: string | null;
  supplier: string | null;
  invoiceNumber: string | null;
  date: string | null;
  confidence: 'high' | 'low';
  /**
   * The lines printed on the receipt, in order. Empty when there are none
   * to read (a card slip, a handwritten note) or the model was not sure.
   * `amountCents` is null for a line whose price could not be read: the
   * name is still worth showing, and a guessed price is not.
   */
  items: ScannedItem[];
}

export interface ScannedItem {
  name: string;
  qty: string;
  amountCents: number | null;
}

/** Matches src/lib/receiptItems.ts. Kept as a number here so this module
 *  stays free of everything but the call. */
const MAX_SCANNED_ITEMS = 60;

export type ScanOutcome =
  | { ok: true; result: ScanResult }
  | { ok: false; error: 'not_configured' | 'unreadable' | 'upstream'; message: string };

const MSG_NOT_CONFIGURED = 'Η ανάγνωση αποδείξεων δεν έχει ρυθμιστεί.';
const MSG_UNREADABLE =
  'Δεν διαβάζεται η απόδειξη. Βγάλτε τη φωτογραφία από κοντά, ίσια και χωρίς τσαλακώματα.';
const MSG_UPSTREAM = 'Η ανάγνωση απέτυχε. Δοκιμάστε ξανά ή γράψτε το ποσό με το χέρι.';

/**
 * Deliberately narrow. It is asked for what is printed, and told to answer
 * null rather than infer — a receipt with a smudged total should come back
 * empty, not with a plausible number.
 */
const PROMPT = `You are reading a photographed receipt or invoice from a restaurant in Cyprus.

Return ONLY a JSON object, no other text, with these keys:
  "total"          the amount PAYABLE INCLUDING VAT, as a string exactly as
                   printed (for example "12,40" or "1.234,56"), or null
  "supplier"       the supplier or shop name, or null
  "invoiceNumber"  the receipt or invoice number, or null
  "date"           the date as YYYY-MM-DD, or null (see the date rule below)
  "totalLabel"     the words printed NEXT TO the total you chose, copied
                   exactly (for example "Total EURO", "Πληρωτέο Ποσό
                   Ευρώ", "Grand Total EUR"), or null
  "confidence"     "high" only if you are certain of the total, otherwise "low"
  "items"          the purchased lines printed on the receipt, in order, as
                   an array of objects (see the item rules below). MUST be
                   the LAST key in the object.

Rules:
- If the total is unclear, obscured, cut off, or you are inferring it from
  other figures, return null for "total" and "low" for confidence. Do not
  guess. A wrong amount is worse than no amount here.
- The total is the final amount payable, not a subtotal and not the VAT.
- "totalLabel" is what makes your answer checkable by the person holding
  the receipt: it lets them look at one line instead of hunting. If you
  cannot point at a printed label for the figure you chose, that is a
  strong sign you are inferring it — return null for "total".
- Amounts may use Greek convention where "." groups thousands and ","
  is the decimal mark. Return the string as printed; do not convert it.
- DATES ARE DAY FIRST. Cyprus writes DD/MM/YYYY, so 01/08/2026 and 01/08/26
  are both 1 August 2026, never 8 January. Convert to YYYY-MM-DD yourself:
  01/08/2026 becomes "2026-08-01". If the day is above 12 the order is
  already unambiguous; below that, still read it day first. Return null if
  the date is unclear rather than picking an order.

Item rules:
- Each item is {"name": ..., "qty": ..., "amount": ...}.
  "name"    the product or service as printed, in the language printed
            (Greek stays Greek). Do not translate, expand or tidy it.
  "qty"     the quantity as printed, with its unit if one is printed
            (for example "2", "1,250 kg", "6 ΤΕΜ"), or "" if none is printed.
  "amount"  the LINE TOTAL for that item as a string exactly as printed
            (for example "12,40"), or null if you cannot read it. The line
            total, not the unit price, when both are printed.
- Only lines for things that were bought. Leave out subtotals, VAT lines,
  the total, payment and change lines, loyalty points, and discounts.
- Do not invent items and do not split or merge printed lines. If the
  receipt has no itemised lines, or they are illegible, return [].
- At most ${MAX_SCANNED_ITEMS} items. If there are more, return the first ${MAX_SCANNED_ITEMS}.
- The items do not have to add up to the total, and you must NOT adjust
  either to make them agree.`;

/**
 * The default is deliberately a model from version 4.7 or later, and that
 * matters more here than it looks.
 *
 * The API scales an image down before the model sees it, and the ceiling
 * depends on the model: 2576px on the long edge for 4.7 and later, 1568px
 * for everything before. A receipt is mostly small print, so that 64%
 * difference in resolution lands directly on whether the total can be read
 * at all. The previous default, claude-sonnet-4-5, was both below that
 * cutoff and no longer in the published model list.
 *
 * Override with ANTHROPIC_SCAN_MODEL to try a stronger one — claude-opus-5-5
 * is the agreed fallback if Sonnet proves unreliable on faded thermal paper.
 * Keep to 4.7 or later, or the image gets smaller rather than the model
 * getting better.
 */
export const DEFAULT_SCAN_MODEL = 'claude-sonnet-5';

export function readScanConfig(
  env: Record<string, string | undefined> = process.env
): { apiKey: string; model: string } | null {
  const apiKey = env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) return null;
  return { apiKey, model: env.ANTHROPIC_SCAN_MODEL || DEFAULT_SCAN_MODEL };
}

/**
 * `parseAmount` is injected rather than imported so this module stays free
 * of everything but the call — and so the ONE parser in src/lib/money.ts
 * remains the only thing that turns a string into cents. A second parser
 * here is exactly the divergence that produced the prototype's `1.234` bug.
 */
export async function scanReceipt(
  image: Buffer,
  mediaType: string,
  parseAmount: (s: string) => number,
  config = readScanConfig(),
  fetchImpl: typeof fetch = fetch
): Promise<ScanOutcome> {
  if (!config) return { ok: false, error: 'not_configured', message: MSG_NOT_CONFIGURED };

  let response: Response;
  try {
    response = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        // Sized for the item list: about 60 tokens a line in Greek, times
        // the item cap, plus the scalar fields. It was 400 when the answer
        // was six short values. Output tokens are what a scan costs, so a
        // long receipt now costs several times what it did — see the note
        // on ANTHROPIC_API_KEY in .env.example.
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: image.toString('base64') },
              },
              { type: 'text', text: PROMPT },
            ],
          },
        ],
      }),
    });
  } catch {
    return { ok: false, error: 'upstream', message: MSG_UPSTREAM };
  }

  if (!response.ok) {
    return { ok: false, error: 'upstream', message: MSG_UPSTREAM };
  }

  let text: string;
  try {
    const body = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
    text = (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  } catch {
    return { ok: false, error: 'upstream', message: MSG_UPSTREAM };
  }

  const parsed = extractJson(text);
  if (!parsed) return { ok: false, error: 'unreadable', message: MSG_UNREADABLE };

  const rawTotal = typeof parsed.total === 'string' ? parsed.total.trim() : '';
  const confidence = parsed.confidence === 'high' ? 'high' : 'low';

  // An amount that parses to zero is not an amount. A receipt for nothing
  // is a misread, and filling a cash sheet with 0,00 silently is precisely
  // the failure this is meant to avoid.
  const cents = rawTotal ? parseAmount(rawTotal) : 0;

  return {
    ok: true,
    result: {
      totalCents: cents > 0 ? cents : null,
      totalLabel: nonEmpty(parsed.totalLabel),
      supplier: nonEmpty(parsed.supplier),
      invoiceNumber: nonEmpty(parsed.invoiceNumber),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date ?? '')) ? String(parsed.date) : null,
      confidence,
      items: readItems(parsed.items, parseAmount),
    },
  };
}

function nonEmpty(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, 200);
  return s === '' ? null : s;
}

/**
 * The item lines, cleaned. Anything that is not a usable line is dropped
 * rather than repaired: a nameless line says nothing, and an amount that
 * does not parse is a price nobody read.
 */
function readItems(raw: unknown, parseAmount: (s: string) => number): ScannedItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ScannedItem[] = [];
  for (const v of raw) {
    if (typeof v !== 'object' || v === null) continue;
    const r = v as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 120) : '';
    if (name === '') continue;
    const qty = typeof r.qty === 'string' ? r.qty.trim().slice(0, 24) : '';
    const rawAmount = typeof r.amount === 'string' ? r.amount.trim() : '';
    let amountCents: number | null = null;
    // Digits and separators only. parseAmount is lenient by design (it
    // serves people typing), and here leniency would turn "2 x 3,10" into
    // a figure. An item printed as free (0,00) keeps its zero: unlike a
    // total of nothing, that is a real line.
    if (rawAmount !== '' && /^[0-9.,\s€]+$/.test(rawAmount)) {
      try {
        const cents = parseAmount(rawAmount);
        if (Number.isSafeInteger(cents) && cents >= 0) amountCents = cents;
      } catch {
        amountCents = null;
      }
    }
    out.push({ name, qty, amountCents });
    if (out.length >= MAX_SCANNED_ITEMS) break;
  }
  return out;
}

/** Tolerates a fenced block or stray prose around the object. */
function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  const end = text.lastIndexOf('}');
  if (end > start) {
    const whole = parseObject(text.slice(start, end + 1));
    if (whole) return whole;
  }
  // The answer was cut off inside the item list — a very long receipt
  // running into max_tokens. The scalar fields come BEFORE "items" (the
  // prompt requires it last), so they are intact: keep them and drop the
  // items, rather than lose a readable total to an unreadable tail. The
  // amount is the part the night depends on.
  const itemsAt = text.indexOf('"items"', start);
  if (itemsAt === -1) return null;
  const head = text.slice(start, itemsAt).replace(/[\s,]+$/, '');
  return parseObject(`${head}}`);
}

function parseObject(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
