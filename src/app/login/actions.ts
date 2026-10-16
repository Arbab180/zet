'use server';

/**
 * The login and logout server actions. Thin: the decision lives in
 * src/server/auth.ts so it stays testable without a running framework,
 * exactly as saveReport.ts is.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { attemptLogin, readAdminConfig } from '../../server/auth';
import { SESSION_COOKIE } from '../../lib/session';
import { lookupLogin } from '../../lib/db';

export type LoginFormState = { error: string | null };

/** Greek, and identical for every failure — see attemptLogin. */
const MSG_BAD = 'Λάθος όνομα ή κωδικός.';
const MSG_NOT_CONFIGURED =
  'Η σύνδεση δεν έχει ρυθμιστεί σε αυτόν τον διακομιστή. Δείτε .env.example.';
const MSG_UNAVAILABLE = 'Η σύνδεση δεν είναι διαθέσιμη αυτή τη στιγμή. Δοκιμάστε ξανά σε λίγο.';

export async function loginAction(
  _prev: LoginFormState,
  formData: FormData
): Promise<LoginFormState> {
  const username = String(formData.get('username') ?? '');
  const password = String(formData.get('password') ?? '');

  const result = await attemptLogin(username, password, readAdminConfig(), lookupLogin);

  if (!result.ok) {
    if (result.reason === 'not_configured') return { error: MSG_NOT_CONFIGURED };
    if (result.reason === 'unavailable') return { error: MSG_UNAVAILABLE };
    return { error: MSG_BAD };
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, result.token, {
    httpOnly: true, // JavaScript on the page can never read it
    sameSite: 'lax', // survives a normal link click, not a cross-site POST
    secure: process.env.NODE_ENV === 'production', // dev is plain http
    path: '/',
    expires: new Date(result.expiresAt),
  });

  redirect('/');
}

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect('/login');
}
