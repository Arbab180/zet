/**
 * Logins, server side. Two kinds, one cookie:
 *
 *   - The ADMIN, configured from the environment exactly as before
 *     (ADMIN_USERNAME / ADMIN_PASSWORD_HASH / ADMIN_USER_ID). It is a
 *     member of every restaurant (db/seed.sql), so it sees them all, and
 *     app_user.is_admin lets it manage the other logins. Keeping it in the
 *     environment means the admin can always sign in, even to a database
 *     that has no restaurant logins yet.
 *   - RESTAURANT logins, one per restaurant, created by the admin on
 *     /accounts and stored in the database (migration 0008). Each is a
 *     member of its own restaurant only, so row-level security shows it
 *     its own nights and nothing else.
 *
 * Configuration, all from the environment, none of it in the repo:
 *
 *   ADMIN_USERNAME       what the admin types on the login form
 *   ADMIN_PASSWORD_HASH  scrypt$... from `npm run hash-password`
 *   ADMIN_USER_ID        the app_user.id the admin authorises as. It must
 *                        exist in app_user and have restaurant_user rows, or
 *                        every save is correctly refused as not_authorised.
 *   SESSION_SECRET       HMAC key for the cookie. Long and random.
 *
 * If any of these is missing the app does not "fall back" to anything: it
 * refuses every login, restaurant logins included. A default credential is
 * how an internal tool ends up reachable with admin/admin, and a
 * generated-per-boot secret silently logs everybody out on each deploy
 * while looking like it works in development.
 *
 * Revocation: a restaurant login's cookie carries its session generation
 * and resolveSession re-checks it against the database on every request,
 * so a password reset signs that restaurant out at once. The admin's
 * cookie has no database row to check and lives until it expires (eight
 * hours) — changing ADMIN_PASSWORD_HASH does not end an admin session
 * already open; changing SESSION_SECRET ends all of them.
 *
 * The throttle below is in-process. It resets on restart and does not span
 * instances. It raises the cost of guessing from a terminal; it is not a
 * defence against a distributed attempt.
 */

import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from '../lib/password';
import type { LoginRecord } from '../lib/db';
import {
  SESSION_TTL_MS,
  createSessionToken,
  readSessionToken,
  type SessionPayload,
} from '../lib/session';
import type { Session } from '../lib/authorize';

export interface AdminConfig {
  username: string;
  passwordHash: string;
  userId: string;
  sessionSecret: string;
}

/**
 * Null when anything is missing — every login then fails closed.
 *
 * Takes a plain string map rather than NodeJS.ProcessEnv: it reads four
 * strings and nothing else, and the narrower type would force every caller
 * (tests included) to supply unrelated variables like NODE_ENV.
 */
export function readAdminConfig(
  env: Record<string, string | undefined> = process.env
): AdminConfig | null {
  const username = env.ADMIN_USERNAME ?? '';
  const passwordHash = env.ADMIN_PASSWORD_HASH ?? '';
  const userId = env.ADMIN_USER_ID ?? '';
  const sessionSecret = env.SESSION_SECRET ?? '';
  if (!username || !passwordHash || !userId || !sessionSecret) return null;
  // A hash mangled by .env `$` expansion arrives as plain `scrypt`. Treat it
  // as missing, so the login page says "not configured" instead of calling
  // every correct password wrong.
  if (!isScryptHashShape(passwordHash)) return null;
  return { username, passwordHash, userId, sessionSecret };
}

function isScryptHashShape(stored: string): boolean {
  const parts = stored.split('$');
  return parts.length === 6 && parts[0] === 'scrypt' && parts.every(Boolean);
}

// ── Throttle ──────────────────────────────────────────────────────────────
// One bucket per typed username (lower-cased), so one restaurant's typos
// do not slow another restaurant down. Keying on IP instead invites someone
// to lock a restaurant out by guessing from elsewhere; this only ever slows
// down, never locks out completely.

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const SLOW_AFTER_ATTEMPTS = 5;
const MAX_DELAY_MS = 5000;
/** Bound on distinct usernames remembered, so random names cannot grow memory. */
const MAX_BUCKETS = 1000;

const recentFailures = new Map<string, number[]>();

function prune(now: number): void {
  for (const [key, times] of recentFailures) {
    const live = times.filter((t) => now - t < ATTEMPT_WINDOW_MS);
    if (live.length === 0) recentFailures.delete(key);
    else recentFailures.set(key, live);
  }
}

function failureDelayMs(key: string, now: number): number {
  const times = (recentFailures.get(key) ?? []).filter((t) => now - t < ATTEMPT_WINDOW_MS);
  // +1 because this runs BEFORE the current attempt is recorded. Without it
  // SLOW_AFTER_ATTEMPTS failures still buy a free un-delayed attempt, which
  // is one more guess than the name of the constant promises. Caught by
  // measuring the delay rather than reading this function.
  const over = times.length - SLOW_AFTER_ATTEMPTS + 1;
  if (over <= 0) return 0;
  return Math.min(MAX_DELAY_MS, 2 ** Math.min(over, 12) * 50);
}

function recordAttempt(key: string, now: number): void {
  if (recentFailures.size >= MAX_BUCKETS && !recentFailures.has(key)) {
    prune(now);
    // Still full: drop the bucket touched longest ago (a Map iterates in
    // insertion order, and every write below re-inserts). Never clear the
    // lot — that would let anyone reset the admin's counter by sending a
    // thousand made-up usernames between guesses.
    if (recentFailures.size >= MAX_BUCKETS) {
      const oldest = recentFailures.keys().next().value;
      if (oldest !== undefined) recentFailures.delete(oldest);
    }
  }
  const times = recentFailures.get(key) ?? [];
  times.push(now);
  recentFailures.delete(key);
  recentFailures.set(key, times);
}

/** Exposed for tests; nothing in the app should need it. */
export function resetLoginThrottle(): void {
  recentFailures.clear();
}

// A real scrypt hash of a random password, made once. Checked against when
// the username does not exist, so an unknown username costs the same time
// as a wrong password and response time cannot reveal which names exist.
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString('base64url'));
  return dummyHash;
}

/** Finds a restaurant login by username. src/lib/db.ts lookupLogin in the app. */
export type LoginLookup = (username: string) => Promise<LoginRecord | null>;

/** For callers (tests) with no database: there are no restaurant logins. */
const noDatabaseLogins: LoginLookup = async () => null;

export type LoginResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; reason: 'not_configured' | 'bad_credentials' | 'unavailable' };

/**
 * One failure reason for a wrong username AND a wrong password. Telling
 * them apart confirms which usernames exist.
 *
 * The admin's username is checked first and never looked up in the
 * database, so the admin can sign in even when the database is down, and
 * no restaurant login can ever be created that shadows it (the accounts
 * page refuses that name too).
 */
export async function attemptLogin(
  username: string,
  password: string,
  config: AdminConfig | null,
  lookup: LoginLookup = noDatabaseLogins,
  now: Date = new Date()
): Promise<LoginResult> {
  if (!config) return { ok: false, reason: 'not_configured' };

  const typed = username.trim();
  const key = typed.toLowerCase();
  const t = now.getTime();

  const delay = failureDelayMs(key, t);
  // Counted as a failure BEFORE the slow hash check, and forgiven only on
  // success. Recorded afterwards, twenty guesses sent at once would all
  // read an empty counter and all go through undelayed.
  recordAttempt(key, t);
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));

  let userId: string;
  let gen: number;
  let passwordMatches: boolean;

  if (typed === config.username) {
    userId = config.userId;
    gen = 0;
    passwordMatches = await verifyPassword(password, config.passwordHash);
  } else {
    let record: LoginRecord | null;
    try {
      record = await lookup(typed);
    } catch {
      // Not "wrong password": that would send someone to reset a password
      // that is fine. Still counted: an outage is no time to guess freely.
      return { ok: false, reason: 'unavailable' };
    }
    // Always run the hash comparison, even when the username is unknown, so
    // a wrong username does not return measurably faster than a wrong password.
    passwordMatches = await verifyPassword(password, record?.passwordHash ?? (await getDummyHash()));
    if (!record) passwordMatches = false;
    userId = record?.userId ?? '';
    gen = record?.sessionGen ?? 0;
    // Only the environment login is the admin. A database row claiming the
    // admin's id or generation 0 is refused rather than trusted.
    if (userId === config.userId || gen < 1) passwordMatches = false;
  }

  if (!passwordMatches) return { ok: false, reason: 'bad_credentials' };

  recentFailures.delete(key);
  const expiresAt = t + SESSION_TTL_MS;
  const payload: SessionPayload = { userId, expiresAt, gen };
  return { ok: true, token: createSessionToken(payload, config.sessionSecret), expiresAt };
}

export interface SessionClaim extends Session {
  /** 0 = the environment admin; >= 1 = a restaurant login's generation. */
  gen: number;
}

/**
 * The cookie value -> what it claims, if the signature holds. Not yet a
 * session: a restaurant login's claim must still pass resolveSession's
 * generation check.
 */
export function sessionFromToken(
  token: string | undefined,
  config: AdminConfig | null,
  now: Date = new Date()
): SessionClaim | null {
  if (!config) return null;
  const payload = readSessionToken(token, config.sessionSecret, now);
  if (!payload) return null;
  return { userId: payload.userId, expiresAt: new Date(payload.expiresAt), gen: payload.gen };
}

/** The current app_login.session_gen for a user, or null if it has none. */
export type SessionGenLookup = (userId: string) => Promise<number | null>;

/**
 * The cookie value -> the Session that authorizeRestaurantAccess expects,
 * or null. Re-checked on every request (CLAUDE.md rule 3):
 *
 *   - gen 0 is valid only for ADMIN_USER_ID — no other id can carry it;
 *   - any other generation must equal the user's current one in the
 *     database, so a password reset ends every older session at once;
 *   - if the database cannot be asked, the answer is "not signed in".
 */
export async function resolveSession(
  token: string | undefined,
  config: AdminConfig | null,
  getGen: SessionGenLookup,
  now: Date = new Date()
): Promise<Session | null> {
  const claim = sessionFromToken(token, config, now);
  if (!claim || !config) return null;

  const session: Session = { userId: claim.userId, expiresAt: claim.expiresAt };
  if (claim.gen === 0) return claim.userId === config.userId ? session : null;
  if (claim.userId === config.userId) return null;

  let current: number | null;
  try {
    current = await getGen(claim.userId);
  } catch {
    return null;
  }
  return current !== null && current === claim.gen ? session : null;
}
