import { cookies } from 'next/headers';
import {
  REVIEW_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  checkPassword,
  createSessionToken,
  reviewAuthConfigured,
  sessionCookieOptions
} from '@/lib/review-auth';

/**
 * POST   /api/review/session - log in to the reviewer UI
 * DELETE /api/review/session - log out
 *
 * The password never reaches the client after this: the response sets an
 * httpOnly cookie the browser cannot read, holding a signed expiring token
 * rather than the password itself.
 */

// No `runtime` export: Node.js is the default in Next 16 and the Edge runtime is
// deprecated. This route needs it regardless, for node:crypto.
export const dynamic = 'force-dynamic';

/** Deliberate delay on a failed attempt.
 *
 * Serverless makes proper rate limiting awkward - there is no shared memory
 * between invocations, and a counter table would be a database write on every
 * guess. A fixed delay is not a substitute for rate limiting, but against an
 * online guessing attack on a 64-character random secret it is more than
 * enough, and it costs nothing to be right about. */
const FAILED_ATTEMPT_DELAY_MS = 1000;

export async function POST(req: Request): Promise<Response> {
  if (!reviewAuthConfigured()) {
    return Response.json(
      {
        error:
          'The reviewer UI is not configured. Set REVIEW_PASSWORD (or JOB_SECRET) ' +
          'to a string of at least 16 characters.'
      },
      { status: 503 }
    );
  }

  let body: { password?: unknown };
  try {
    body = (await req.json()) as { password?: unknown };
  } catch {
    return Response.json({ error: 'invalid request' }, { status: 400 });
  }

  const password = typeof body.password === 'string' ? body.password : '';

  if (!password || !checkPassword(password)) {
    await new Promise((r) => setTimeout(r, FAILED_ATTEMPT_DELAY_MS));
    return Response.json({ error: 'Incorrect password.' }, { status: 401 });
  }

  const jar = await cookies();
  jar.set({
    ...sessionCookieOptions(SESSION_TTL_SECONDS),
    value: createSessionToken()
  });

  return Response.json({ ok: true });
}

export async function DELETE(): Promise<Response> {
  const jar = await cookies();
  jar.set({ ...sessionCookieOptions(0), name: REVIEW_COOKIE_NAME, value: '' });
  return Response.json({ ok: true });
}
