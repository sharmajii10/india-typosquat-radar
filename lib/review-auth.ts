import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Authentication for the reviewer UI.
 *
 * The review queue can publish an accusation and can permanently allowlist a
 * domain, so it needs to be genuinely closed - not merely unlisted. This is a
 * signed, expiring session cookie behind a single shared password.
 *
 * WHY NOT just put the secret in the URL: a query parameter leaks into browser
 * history, the Referer header on any outbound click, and server access logs.
 * For a page whose whole job is deciding what to publish about other people,
 * that is not acceptable.
 *
 * WHY A SHARED PASSWORD rather than real accounts: this is a single-operator
 * public-good project with no user table and no email delivery. Adding an auth
 * provider would be the largest dependency in the codebase, for one reviewer.
 * The honest trade-off is recorded here rather than hidden: if more than one
 * person ever reviews, replace this with real accounts, because a shared
 * password cannot tell you who cleared a domain.
 *
 * Set `REVIEW_PASSWORD` to a long random string. If it is unset the reviewer UI
 * falls back to `JOB_SECRET`, so the page works on an existing deployment with
 * no new configuration - but a dedicated password is better, because JOB_SECRET
 * also lives in GitHub Actions and is therefore known to more systems.
 *
 * If NEITHER is set, the UI refuses every login rather than falling open.
 */

const COOKIE_NAME = 'radar_review';
const SESSION_TTL_MS = 8 * 3600_000;

/** Minimum password length. Short enough to type, long enough that guessing is
 *  not the weak point compared to everything else. */
const MIN_PASSWORD_LENGTH = 16;

export { COOKIE_NAME as REVIEW_COOKIE_NAME };

function reviewPassword(): string | null {
  const explicit = process.env.REVIEW_PASSWORD;
  if (explicit && explicit.length >= MIN_PASSWORD_LENGTH) return explicit;

  const fallback = process.env.JOB_SECRET;
  if (fallback && fallback.length >= MIN_PASSWORD_LENGTH) return fallback;

  return null;
}

export function reviewAuthConfigured(): boolean {
  return reviewPassword() !== null;
}

/** True when the UI is using JOB_SECRET rather than a dedicated password, so
 *  the page can say so instead of leaving it implicit. */
export function usingJobSecretFallback(): boolean {
  const explicit = process.env.REVIEW_PASSWORD;
  return !(explicit && explicit.length >= MIN_PASSWORD_LENGTH) && reviewAuthConfigured();
}

export function checkPassword(supplied: string): boolean {
  const expected = reviewPassword();
  if (!expected) return false;

  // Compare fixed-length digests so the comparison cost does not reveal the
  // password's length, and so timingSafeEqual never throws on a mismatch.
  const a = createHmac('sha256', 'review-password-check').update(supplied).digest();
  const b = createHmac('sha256', 'review-password-check').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Session token: `<expiry>.<nonce>.<hmac>`.
 *
 * Signed with the password itself, so changing the password invalidates every
 * outstanding session - which is the behaviour you want from the one lever
 * available for revoking access.
 */
export function createSessionToken(): string {
  const secret = reviewPassword();
  if (!secret) throw new Error('review auth is not configured');

  const expiresAt = Date.now() + SESSION_TTL_MS;
  const nonce = randomBytes(12).toString('hex');
  const payload = `${expiresAt}.${nonce}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const secret = reviewPassword();
  if (!secret) return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const [expiresAt, nonce, signature] = parts;
  const payload = `${expiresAt}.${nonce}`;

  const expected = sign(payload, secret);
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;

  const expiry = Number(expiresAt);
  return Number.isFinite(expiry) && expiry > Date.now();
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Cookie attributes. `secure` is omitted in development so the login works
 *  over plain HTTP on localhost; every deployment is HTTPS. */
export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    name: COOKIE_NAME,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds
  };
}

export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;
