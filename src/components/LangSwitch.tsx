'use client';

/**
 * ΕΛ | EN, top right of every page.
 *
 * Writes the choice to a cookie and asks the router to re-render. That
 * refresh is a soft one: Server Components render again in the new
 * language, but Client Component state is kept — a half-filled sheet
 * stays half-filled, it just changes language around the figures.
 *
 * The cookie is per device, so each restaurant's phone keeps its own.
 */

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { LANG_COOKIE, LANG_COOKIE_MAX_AGE, type Lang } from '../lib/i18n';
import { useLang } from './LangProvider';
import styles from './LangSwitch.module.css';

const OPTIONS: Array<{ lang: Lang; label: string; name: string }> = [
  { lang: 'el', label: 'ΕΛ', name: 'Ελληνικά' },
  { lang: 'en', label: 'EN', name: 'English' },
];

export default function LangSwitch() {
  const current = useLang();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function choose(lang: Lang) {
    if (lang === current) return;
    document.cookie = `${LANG_COOKIE}=${lang}; path=/; max-age=${LANG_COOKIE_MAX_AGE}; samesite=lax`;
    startTransition(() => router.refresh());
  }

  return (
    <div className={styles.bar}>
      <div className={styles.switch} role="group" aria-label="Language / Γλώσσα" aria-busy={pending}>
        {OPTIONS.map((o) => (
          <button
            key={o.lang}
            type="button"
            lang={o.lang}
            title={o.name}
            aria-pressed={o.lang === current}
            className={o.lang === current ? styles.active : styles.option}
            onClick={() => choose(o.lang)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
