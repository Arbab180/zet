/**
 * Reads the signed cookie and hands back the Session that
 * authorizeRestaurantAccess expects, or null.
 *
 * One place, so no route invents its own idea of who is signed in.
 *
 * Note what this deliberately does NOT do: it never trusts anything but the
 * signature and, for a restaurant login, the database's current session
 * generation (see resolveSession). There is no "if no cookie, assume dev
 * user" branch — that is the shortcut that ships to production and makes
 * every request an admin.
 */

import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '../lib/session';
import { readAdminConfig, resolveSession } from './auth';
import { getSessionGen } from './accounts';
import type { Session } from '../lib/authorize';

export async function getCurrentSession(): Promise<Session | null> {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value, readAdminConfig(), getSessionGen);
}
