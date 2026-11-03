/**
 * The language for this request, for Server Components and Server Actions.
 * Read from the cookie LangSwitch sets; Greek when there is none.
 */

import { cookies } from 'next/headers';
import { LANG_COOKIE, makeT, parseLang, type Lang, type T } from '../lib/i18n';

export async function getLang(): Promise<Lang> {
  const store = await cookies();
  return parseLang(store.get(LANG_COOKIE)?.value);
}

export async function getT(): Promise<T> {
  return makeT(await getLang());
}
