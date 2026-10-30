/**
 * Money for the ZET app.
 *
 * Everything is integer cents. Never floats: 0.1 + 0.2 !== 0.3, and a cash
 * reconciliation that is off by a cent gets rejected by whoever signs it.
 */

export type Cents = number;

const formatter = new Intl.NumberFormat('el-GR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** 40807 -> "408,07" */
export function formatCents(cents: Cents): string {
  return formatter.format((cents || 0) / 100);
}

/**
 * Four digits or more with no comma or dot: the last two are cents.
 * Managers key prices the way a till does, so 1946 is 19,46 and 12345 is
 * 123,45. Up to three digits stay whole euros: 5 is 5,00, 194 is 194,00
 * (Arbab, 30/10/2026). Anything with a comma or dot is read as typed.
 */
const AUTO_DECIMAL = /^(-?)(\d{4,})$/;

/** Is this a figure the auto-decimal rule rewrites? */
export function isAutoDecimal(raw: string): boolean {
  return AUTO_DECIMAL.test(raw.trim().replace(/[€\s]/g, ''));
}

/**
 * Parse what a manager typed into a money box: the auto-decimal rule
 * above, then parsePrintedCents. Never use this for a figure read off a
 * printed receipt — "1500" printed on an invoice is fifteen hundred.
 */
export function parseCents(input: string | null | undefined): Cents {
  if (input == null) return 0;
  const m = AUTO_DECIMAL.exec(String(input).trim().replace(/[€\s]/g, ''));
  if (m) {
    const cents = Number(m[2]);
    return m[1] && cents !== 0 ? -cents : cents;
  }
  return parsePrintedCents(input);
}

/**
 * Parse an amount a Cypriot manager might type.
 *
 * el-GR groups thousands with a DOT and uses a comma for decimals, so
 * "1.234" is one thousand two hundred thirty four — not 1.234. An earlier
 * version of this function missed that and read it as EUR 1,23, silently
 * recording a day's takings as one euro twenty-three. Do not "simplify" the
 * branch below without running money.test.ts.
 *
 * Both conventions are accepted, because people type both.
 */
export function parsePrintedCents(input: string | null | undefined): Cents {
  if (input == null) return 0;
  let s = String(input).trim().replace(/[€\s]/g, '');
  // A leading minus is only ever typed into the envelope cash box (see
  // sanitizeSignedAmountInput); every other box strips it before here.
  const negative = s.startsWith('-');
  if (negative) s = s.slice(1);
  if (!s) return 0;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if (lastComma > -1 && lastDot > -1) {
    // Both marks present: whichever comes last is the decimal separator.
    s = lastComma > lastDot
      ? s.replace(/\./g, '').replace(/,/g, '.')
      : s.replace(/,/g, '');
  } else if (lastComma > -1 || lastDot > -1) {
    // One mark only. Treat it as a group separator when it repeats, or when
    // it leaves exactly three digits behind it.
    const sep = lastComma > -1 ? ',' : '.';
    const last = lastComma > -1 ? lastComma : lastDot;
    const parts = s.split(sep);
    s = parts.length > 2 || s.length - last - 1 === 3
      ? parts.join('')
      : parts.join('.');
  }

  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  const cents = Math.round(n * 100);
  return negative && cents !== 0 ? -cents : cents;
}

/** Every character an amount may contain — digits, both separators, a
 *  euro sign, spaces. Shared so the browser and the server can never
 *  disagree about what counts as a figure. */
const AMOUNT_CHARS = /^[0-9.,\s€]*$/;

export function isAmountText(raw: string): boolean {
  return AMOUNT_CHARS.test(raw);
}

/**
 * Read a box that may hold a figure OR a note — the ΤΑΜΕΙΟ Dine in and
 * T/A boxes, which managers write words in.
 *
 * A box is one or the other, never both taken apart. "ΝΙΜΑ 52,20" is
 * kept whole as a note rather than having 52,20 picked out of it:
 * guessing which number in free text is THE figure is the kind of
 * inference that is wrong silently, and these two boxes feed no
 * arithmetic — only the "Dine in + T/A do not add up to Total" hint —
 * so there is nothing to gain by guessing and a wrong stored figure to
 * lose.
 */
export function splitFigureOrNote(raw: string): { cents: Cents; note: string } {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { cents: 0, note: '' };
  if (isAmountText(trimmed)) return { cents: parseCents(trimmed), note: '' };
  return { cents: 0, note: trimmed };
}

/**
 * Strip anything that is not part of a number, as the user types.
 * A stray letter otherwise parses to 0 and swallows a real figure.
 *
 * There is deliberately NO upper limit: a big number is usually a real day,
 * and a wrong one shows up in the reconciliation anyway.
 */
export function sanitizeAmountInput(raw: string): string {
  return raw.replace(/[^0-9.,]/g, '');
}

/**
 * The envelope cash box, which may go below zero: some nights the till
 * pays out more than it took, and the shortfall is made up at the next
 * close-out. One leading minus is kept; anything else is cleaned as in
 * sanitizeAmountInput.
 */
export function sanitizeSignedAmountInput(raw: string): string {
  const negative = raw.trim().startsWith('-');
  const rest = sanitizeAmountInput(raw);
  return negative ? `-${rest}` : rest;
}

/** The ± button: the iPhone decimal keypad has no minus key. */
export function flipSign(raw: string): string {
  const t = raw.trim();
  return t.startsWith('-') ? t.slice(1) : `-${t}`;
}


/**
 * What a money box shows for what was typed: an auto-decimal figure is
 * shown with its comma as it is typed (1946 shows 19,46), so the manager
 * sees the amount the sheet will use. Everything else is shown as typed.
 */
export function amountDisplay(raw: string): string {
  if (!isAutoDecimal(raw)) return raw;
  return formatCents(parseCents(raw));
}

/**
 * Turn an edit of the shown text back into what was typed.
 *
 * While the box shows an auto-decimal figure, its comma and dots were put
 * there by amountDisplay, not typed, so they are taken out again: 19,46
 * with a 5 typed after it is "19,465" → 19465 → shows 194,65.
 * A comma or dot typed at the END is the manager's own, and switches the
 * box back to as-typed: 19,46 then "," is 1946, — €1.946 and counting.
 */
export function rawFromEdit(prevRaw: string, shown: string): string {
  if (!isAutoDecimal(prevRaw)) return shown;
  const sign = shown.trim().startsWith('-') ? '-' : '';
  const digits = shown.replace(/[^0-9]/g, '');
  const seps = (t: string) => (t.match(/[.,]/g) ?? []).length;
  const last = shown.trim().slice(-1);
  if ((last === ',' || last === '.') && seps(shown) > seps(amountDisplay(prevRaw))) {
    return `${sign}${digits}${last}`;
  }
  return `${sign}${digits}`;
}
