import { isAuthorizedJobRequest, unauthorized } from '@/lib/auth';
import { serviceClient } from '@/lib/db';

/**
 * The human review queue - the other half of the confidence gate.
 *
 * Medium-tier candidates never auto-publish. They land here and wait for a
 * person. This route is the minimum viable version of that: a secured JSON
 * endpoint behind the same shared secret as the jobs, driven by curl. A proper
 * reviewer UI is worth building, but a queue nobody can act on is worse than a
 * plain endpoint that works, and this ships today.
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

  if (queue === 'reports') {
    const { data, error } = await db
      .from('reports')
      .select('id, candidate_id, domain, kind, note, contact, status, created_at')
      .eq('status', 'open')
      .order('created_at', { ascending: true })
      .limit(200);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ queue: 'reports', count: data?.length ?? 0, items: data ?? [] });
  }

  const { data, error } = await db
    .from('public_feed')
    .select('*')
    .eq('publish_state', 'pending_review')
    .order('score', { ascending: false })
    .limit(200);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({
    queue: 'candidates',
    count: data?.length ?? 0,
    items: data ?? []
  });
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
  if (!['publish', 'clear', 'hide'].includes(action)) {
    return Response.json(
      { error: 'action must be one of: publish, clear, hide' },
      { status: 400 }
    );
  }

  const db = serviceClient();

  const { data: candidate, error: findErr } = await db
    .from('candidates')
    .select('id, domain, matched_brand_id')
    .eq('id', id)
    .single();

  if (findErr || !candidate) {
    return Response.json({ error: 'candidate not found' }, { status: 404 });
  }

  const publishState =
    action === 'publish' ? 'published' : action === 'clear' ? 'cleared' : 'hidden';

  const { error: updateErr } = await db
    .from('candidates')
    .update({
      publish_state: publishState,
      reviewed_at: new Date().toISOString(),
      reviewed_note: note ?? null,
      // A cleared domain stops being rechecked. Nothing it does later should put
      // it back on a public list without another human decision.
      ...(action === 'clear' ? { status: 'retired' } : {})
    })
    .eq('id', id);

  if (updateErr) return Response.json({ error: updateErr.message }, { status: 500 });

  if (action === 'clear') {
    await db.from('allowlist').upsert(
      {
        domain: candidate.domain,
        brand_id: candidate.matched_brand_id,
        reason: note ?? 'Cleared on human review',
        added_by: 'review'
      },
      { onConflict: 'domain' }
    );

    // Resolve any open disputes about this domain.
    await db
      .from('reports')
      .update({
        status: 'resolved',
        resolved_at: new Date().toISOString(),
        resolution: note ?? 'Domain cleared and allowlisted.'
      })
      .eq('candidate_id', id)
      .eq('status', 'open');
  }

  return Response.json({
    ok: true,
    domain: candidate.domain,
    publish_state: publishState,
    allowlisted: action === 'clear'
  });
}
