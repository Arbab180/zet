/**
 * English / Greek, for the whole app.
 *
 * How it works — the gettext way. Greek stays the source text everywhere:
 * in the components, in src/lib/messages.ts, in the sheet configs in
 * src/lib/forms.ts, in what the server sends back. Nothing that compares
 * or stores a message changes. Translation happens at ONE place, the edge
 * where text is put on screen, by passing it through `t()`:
 *
 *     t('Ημερομηνία')            → 'Date' in English, unchanged in Greek
 *     t('αναθεώρηση {n}', { n: 3 })     → 'revision 3'
 *
 * The English is looked up in src/lib/i18n/en.ts, keyed by the Greek.
 * Anything with no entry comes back as it was — so "SIX CARDS", a
 * restaurant's address or what a manager typed pass straight through.
 *
 * Text built elsewhere with numbers or names already inside it (the
 * server's "λείπουν 3 πράγματα", a flag's "διαφορά €4,20") still
 * translates: an entry whose key has {placeholders} also matches as a
 * pattern, and the parts it captures are themselves translated.
 *
 * What is deliberately NOT translated: the Sofia export (the accountants'
 * import format is Greek), and anything a person typed.
 *
 * Framework-free on purpose, like messages.ts: the server and the browser
 * both import it.
 */

import { EN } from './en';

export type Lang = 'el' | 'en';
export const LANGS: readonly Lang[] = ['el', 'en'];
export const DEFAULT_LANG: Lang = 'el';

/** One cookie per device. A year, so a restaurant's phone remembers. */
export const LANG_COOKIE = 'zet_lang';
export const LANG_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function parseLang(value: string | null | undefined): Lang {
  return value === 'en' ? 'en' : DEFAULT_LANG;
}

export type Vars = Record<string, string | number>;
export type T = (text: string, vars?: Vars) => string;

function fill(template: string, vars: Vars | undefined): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole
  );
}

interface Pattern {
  re: RegExp;
  names: string[];
  english: string;
}

let patterns: Pattern[] | null = null;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Entries with {placeholders}, compiled once, longest key first. */
function compiledPatterns(): Pattern[] {
  if (patterns) return patterns;
  patterns = Object.entries(EN)
    .filter(([greek]) => /\{\w+\}/.test(greek))
    .sort((a, b) => b[0].length - a[0].length)
    .map(([greek, english]) => {
      const names: string[] = [];
      const source = greek
        .split(/(\{\w+\})/)
        .map((part) => {
          const m = /^\{(\w+)\}$/.exec(part);
          if (!m) return escapeRe(part);
          names.push(m[1]!);
          return '([\\s\\S]*?)';
        })
        .join('');
      return { re: new RegExp(`^${source}$`), names, english };
    });
  return patterns;
}

/**
 * The one function. Greek in, the chosen language out.
 * `vars` fills {placeholders} in whichever language is returned.
 */
export function translate(lang: Lang, text: string, vars?: Vars): string {
  if (lang === 'el' || text === '') return fill(text, vars);

  const exact = EN[text];
  if (exact !== undefined) return fill(exact, vars);

  // Already-filled text, e.g. "Δεν αποθηκεύτηκε — λείπουν 3 πράγματα".
  for (const p of compiledPatterns()) {
    const m = p.re.exec(text);
    if (!m) continue;
    const captured: Vars = {};
    p.names.forEach((name, i) => {
      captured[name] = translate(lang, m[i + 1] ?? '');
    });
    return fill(fill(p.english, captured), vars);
  }

  return fill(text, vars);
}

export function makeT(lang: Lang): T {
  return (text, vars) => translate(lang, text, vars);
}
