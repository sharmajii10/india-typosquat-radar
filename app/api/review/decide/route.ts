import { cookies } from 'next/headers';
import { serviceClient } from '@/lib/db';
import { REVIEW_ACTIONS, applyReviewDecision, type ReviewAction } from '@/lib/pipeline/review';
import { REVIEW_COOKIE_NAME, verifySessionToken } from '@/lib/review-auth';

/**
 * POST /api/review/decide - the reviewer UI's action endpoint.
 *
 * Gated on the session cookie, not the job secret. It uses the service key, so
 * an unauthenticated call here would be able to publish an accusation about any
 * domain - the auth check is the first thing it does and there is no path past
 * it.
 */

// No `runtime` export: Node.js is the default in Next 16 and the Edge runtime is
// deprecated. Needed here regardless, for node:crypto in the session check.
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const jar = await cookies();
  if (!verifySessionToken(jar.get(REVIEW_COOKIE_NAME)?.value)) {
    return Response.json({ error: 'not signed in' }, { status: 401 });
  }

  let body: { id?: unknown; action?: unknown; note?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'invalid request' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id : '';
  const action = typeof body.action === 'string' ? body.action : '';
  const note = typeof body.note === 'string' ? body.note.trim() : '';

  if (!id) return Response.json({ error: 'missing candidate id' }, { status: 400 });
  if (!REVIEW_ACTIONS.includes(action as ReviewAction)) {
    return Response.json(
      { error: `action must be one of: ${REVIEW_ACTIONS.join(', ')}` },
      { status: 400 }
    );
  }

  // Clearing a domain writes a permanent allowlist entry that suppresses it
  // forever. Requiring a reason makes that decision auditable later, when
  // nobody remembers why.
  if (action === 'clear' && note.length < 3) {
    return Response.json(
      { error: 'Clearing a domain needs a short reason, for the record.' },
      { status: 400 }
    );
  }

  try {
    const outcome = await applyReviewDecision(serviceClient(), {
      id,
      action: action as ReviewAction,
      note: note || undefined,
      reviewer: 'review-ui'
    });
    return Response.json({ ok: true, ...outcome });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message === 'candidate not found' ? 404 : 500;
    return Response.json({ error: message }, { status });
  }
}
