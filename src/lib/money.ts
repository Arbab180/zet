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
export function parseCents(input: string | null | undefined): Cents {
  if (input == null) return 0;
  let s = String(input).trim().replace(/[€\s]/g, '');
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
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
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
