import { isAuthorizedJobRequest, unauthorized } from '@/lib/auth';
import { serviceClient } from '@/lib/db';
import {
  REVIEW_ACTIONS,
  applyReviewDecision,
  loadOpenReports,
  loadReviewQueue,
  type ReviewAction
} from '@/lib/pipeline/review';

/**
 * The human review queue - the other half of the confidence gate.
 *
 * Medium-tier candidates never auto-publish. They land here and wait for a
 * person. This is the machine-readable half of that queue, behind the job
 * secret and driven by curl; the human half is the UI at `/review`.
 *
 * Both call `applyReviewDecision` in lib/pipeline/review.ts, so a decision made
 * here and one made in the UI cannot behave differently.
 *
 *   GET  /api/jobs/review                 - list what is waiting
 *   GET  /api/jobs/review?queue=reports   - list open disputes
 *   POST /api/jobs/review                 - decide on one candidate
 *
 * POST body:
 *   { "id": "<candidate uuid>", "action": "publish" | "clear" | "hide", "note": "..." }
 *
 * `clear` is the dispute outcome. It is sticky: a cleared domain is added to the
 * allowlist and can never be re-published by a later scoring run, because a
 * person looked at it and said it was legitimate. Getting wrongly listed once is
 * bad enough; getting re-listed a week later after complaining would be worse.
 */

// No `runtime` export: Node.js is the default in Next 16 and the Edge runtime is
// deprecated, so the framework's own guidance is to omit it. This route needs the
// Node runtime regardless - it uses node:dns, node:crypto and outbound fetch.
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorizedJobRequest(req)) return unauthorized();

  const db = serviceClient();
  const queue = new URL(req.url).searchParams.get('queue') ?? 'candidates';

  try {
    if (queue === 'reports') {
      const items = await loadOpenReports(db, 200);
      return Response.json({ queue: 'reports', count: items.length, items });
    }
    const items = await loadReviewQueue(db, 200);
    return Response.json({ queue: 'candidates', count: items.length, items });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!isAuthorizedJobRequest(req)) return unauthorized();

  let body: { id?: string; action?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { id, action, note } = body;
  if (!id || !action) {
    return Response.json({ error: 'id and action are required' }, { status: 400 });
  }
  if (!REVIEW_ACTIONS.includes(action as ReviewAction)) {
    return Response.json(
      { error: `action must be one of: ${REVIEW_ACTIONS.join(', ')}` },
      { status: 400 }
    );
  }

  try {
    // Same implementation the reviewer UI calls. Two copies of "clear a domain"
    // would drift, and the one that drifted would be the one that forgot to
    // write the allowlist row.
    const outcome = await applyReviewDecision(serviceClient(), {
      id,
      action: action as ReviewAction,
      note,
      reviewer: 'api'
    });
    return Response.json({ ok: true, ...outcome });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: message },
      { status: message === 'candidate not found' ? 404 : 500 }
    );
  }
}
