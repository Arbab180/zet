'use client';

/**
 * Hands the chosen language to every Client Component.
 *
 * The root layout (a Server Component) reads the language cookie once per
 * request and passes it in here. A Client Component then calls `useT()`
 * instead of reading the cookie itself — so the server-rendered HTML and
 * the browser's first render always agree on the language (no flash of
 * Greek, no hydration mismatch).
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { DEFAULT_LANG, makeT, type Lang, type T } from '../lib/i18n';

const LangContext = createContext<Lang>(DEFAULT_LANG);

export function LangProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}

export function useLang(): Lang {
  return useContext(LangContext);
}

export function useT(): T {
  const lang = useContext(LangContext);
  return useMemo(() => makeT(lang), [lang]);
}
