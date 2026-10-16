/**
 * Session tokens: a small payload plus an HMAC-SHA256 signature, carried in
 * a cookie.
 *
 * No JWT library. The payload here is three fields and the algorithm is one
 * HMAC — a dependency would add a parser, an algorithm-negotiation field
 * and a long history of `alg: none` style confusions in exchange for
 * nothing this needs.
 *
 * What the signature buys: the browser holds the session but cannot change
 * it. Editing the user id or the expiry invalidates the signature, because
 * producing a valid one needs SESSION_SECRET, which never leaves the server.
 *
 * What it does NOT buy on its own: revocation. That comes from `gen`: a
 * restaurant login's token carries the session generation it was issued
 * under, and src/server/currentSession.ts compares it with the database on
 * every request. Resetting that login's password bumps the generation, so
 * every cookie issued before the reset stops working at once. The admin
 * (gen 0) is configured from the environment and has no row to bump; its
 * tokens still live until they expire.
 *
 * A token without `gen` — every token issued before restaurant logins
 * existed — is rejected. That signs everybody out once, on the deploy that
 * introduces it, which is intended: an old token cannot say which kind of
 * login made it.
 *
 * Pure and secret-injected, so it is testable without a running app.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionPayload {
  /** app_user.id — the same id authorizeRestaurantAccess looks up. */
  userId: string;
  /** Unix milliseconds. */
  expiresAt: number;
  /**
   * 0 for the admin configured in the environment; otherwise the
   * app_login.session_gen this token was issued under (always >= 1).
   */
  gen: number;
}

export const SESSION_COOKIE = 'zet_session';

/** Eight hours: longer than a closing shift, shorter than a week. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(body: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(body).digest());
}

export function createSessionToken(payload: SessionPayload, secret: string): string {
  if (!secret) throw new Error('SESSION_SECRET is empty — refusing to sign a session');
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${sign(body, secret)}`;
}

/**
 * Returns null for anything that is not a currently-valid token: wrong
 * shape, bad signature, expired, unparseable, wrong field types. One return
 * value for every failure, so no caller can accidentally treat "expired" as
 * "signed in".
 */
export function readSessionToken(
  token: string | undefined | null,
  secret: string,
  now: Date = new Date()
): SessionPayload | null {
  try {
    if (!token || !secret) return null;

    const dot = token.indexOf('.');
    if (dot < 1 || dot === token.length - 1) return null;
    const body = token.slice(0, dot);
    const provided = token.slice(dot + 1);

    const expected = sign(body, secret);
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    // Length differs -> definitely not a match, and timingSafeEqual would
    // throw on mismatched lengths.
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;

    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p.userId !== 'string' || p.userId === '') return null;
    if (typeof p.expiresAt !== 'number' || !Number.isFinite(p.expiresAt)) return null;
    if (p.expiresAt <= now.getTime()) return null;
    if (typeof p.gen !== 'number' || !Number.isInteger(p.gen) || p.gen < 0) return null;

    return { userId: p.userId, expiresAt: p.expiresAt, gen: p.gen };
  } catch {
    return null;
  }
}
