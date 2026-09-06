import type { SupabaseClient } from '@supabase/supabase-js';
import type { PublishState } from '@/lib/types';

/**
 * The human review decision, in one place.
 *
 * Both entry points route through here - the curl-driven `/api/jobs/review`
 * endpoint and the reviewer UI at `/review`. Two implementations of "clear a
 * domain" would drift, and the one that drifted would be the one that forgot to
 * write the allowlist row, which is the step that makes a correction permanent.
 */

export type ReviewAction = 'publish' | 'clear' | 'hide';

export const REVIEW_ACTIONS: ReviewAction[] = ['publish', 'clear', 'hide'];

export interface ReviewDecision {
  id: string;
  action: ReviewAction;
  note?: string;
  /** Free-text label for who decided, stored on the allowlist row. */
  reviewer?: string;
}

export interface ReviewOutcome {
  domain: string;
  publishState: PublishState;
  allowlisted: boolean;
  resolvedReports: number;
}

const PUBLISH_STATE_FOR: Record<ReviewAction, PublishState> = {
  publish: 'published',
  clear: 'cleared',
  hide: 'hidden'
};

export async function applyReviewDecision(
  db: SupabaseClient,
  decision: ReviewDecision
): Promise<ReviewOutcome> {
  const { id, action, note, reviewer } = decision;

  const { data: candidate, error: findErr } = await db
    .from('candidates')
    .select('id, domain, matched_brand_id')
    .eq('id', id)
    .single();

  if (findErr || !candidate) {
    throw new Error('candidate not found');
  }

  const publishState = PUBLISH_STATE_FOR[action];

  const { error: updateErr } = await db
    .from('candidates')
    .update({
      publish_state: publishState,
      reviewed_at: new Date().toISOString(),
      reviewed_note: note ?? null,
      // A cleared domain stops being rechecked. Nothing it does later should
      // put it back on a public list without another human decision.
      ...(action === 'clear' ? { status: 'retired' } : {})
    })
    .eq('id', id);

  if (updateErr) throw new Error(updateErr.message);

  let allowlisted = false;
  let resolvedReports = 0;

  if (action === 'clear') {
    // The allowlist write is what makes the correction permanent. Without it a
    // later scoring run would happily re-flag the same domain, which for
    // someone who has already disputed a listing is worse than the original
    // mistake.
    const { error: allowErr } = await db.from('allowlist').upsert(
      {
        domain: candidate.domain,
        brand_id: candidate.matched_brand_id,
        reason: note ?? 'Cleared on human review',
        added_by: reviewer ?? 'review'
      },
      { onConflict: 'domain' }
    );
    if (allowErr) throw new Error(`cleared, but allowlisting failed: ${allowErr.message}`);
    allowlisted = true;

    const { data: resolved } = await db
      .from('reports')
      .update({
        status: 'resolved',
        resolved_at: new Date().toISOString(),
        resolution: note ?? 'Domain cleared and allowlisted.'
      })
      .eq('candidate_id', id)
      .eq('status', 'open')
      .select('id');
    resolvedReports = resolved?.length ?? 0;
  }

  return {
    domain: candidate.domain as string,
    publishState,
    allowlisted,
    resolvedReports
  };
}

/** Everything waiting on a human, most suspicious first. */
export async function loadReviewQueue(db: SupabaseClient, limit = 100) {
  const { data, error } = await db
    .from('public_feed')
    .select('*')
    .eq('publish_state', 'pending_review')
    .order('score', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Open disputes. Shown beside the queue because a dispute about a domain is
 *  the single most important thing to know before deciding on it. */
export async function loadOpenReports(db: SupabaseClient, limit = 100) {
  const { data, error } = await db
    .from('reports')
    .select('id, candidate_id, domain, kind, note, contact, created_at')
    .eq('status', 'open')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(error.message);
  return data ?? [];
}
