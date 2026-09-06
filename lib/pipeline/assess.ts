import type { SupabaseClient } from '@supabase/supabase-js';
import { RECHECK_INTERVALS_HOURS, RETIRE_AFTER_DEAD_RECHECKS } from '@/lib/config';
import { publishStateForTier, scoreCandidate } from '@/lib/scoring/score';
import type { Brand, Candidate, PublishState, Tier } from '@/lib/types';
import { toVerificationRow, verifyDomain } from '@/lib/verify';

/**
 * Verify one candidate, score it, gate it, and schedule its next look.
 *
 * This is the only place in the codebase that writes `publish_state`, which
 * makes the publication decision auditable: there is exactly one code path from
 * evidence to visibility.
 */

export interface AssessResult {
  domain: string;
  score: number;
  tier: Tier;
  publishState: PublishState;
  resolves: boolean;
  retired: boolean;
}

export async function assessCandidate(
  db: SupabaseClient,
  candidate: Candidate,
  brand: Brand,
  deadlineAt: number
): Promise<AssessResult> {
  // Terms to look for in the page body: the brand's display name plus its
  // match terms, so a cloned page that says "HDFC Bank" is caught as well as
  // one that only carries the token in a URL.
  const brandTerms = [brand.name, ...brand.match_terms, ...brand.aliases];

  const bundle = await verifyDomain(candidate.domain, brandTerms, deadlineAt);

  const { data: verificationRow, error: vErr } = await db
    .from('verifications')
    .insert(toVerificationRow(candidate.id, bundle))
    .select('id')
    .single();
  if (vErr) throw new Error(`verification insert failed: ${vErr.message}`);

  const scored = scoreCandidate({
    candidate,
    verification: bundle,
    brandName: brand.name
  });

  // Store the gate note alongside the evidence so the public page can explain
  // why something is "under review" rather than listed as confirmed.
  const signals = scored.gateNote
    ? [
        ...scored.signals,
        {
          key: 'gate.note',
          label: scored.gateNote,
          points: 0,
          category: 'mitigating' as const
        }
      ]
    : scored.signals;

  const { error: sErr } = await db.from('risk_scores').insert({
    candidate_id: candidate.id,
    verification_id: verificationRow?.id ?? null,
    score: scored.score,
    tier: scored.tier,
    contributing_signals: signals,
    weights_version: scored.weightsVersion
  });
  if (sErr) throw new Error(`risk score insert failed: ${sErr.message}`);

  const publishState = publishStateForTier(scored.tier, candidate.publish_state);

  // --- Recheck scheduling --------------------------------------------------
  // A candidate is judged repeatedly, not once. The cadence reflects how likely
  // the domain is to change: live and interesting gets looked at often, live and
  // boring rarely, dormant slowly but indefinitely (a domain that wakes up six
  // months later is exactly the case a one-shot judgement would miss).
  const deadStreak = bundle.dns.resolves ? 0 : candidate.recheck_count + 1;
  const retired =
    !bundle.dns.resolves &&
    deadStreak >= RETIRE_AFTER_DEAD_RECHECKS &&
    scored.tier === 'low';

  const intervalHours = retired
    ? RECHECK_INTERVALS_HOURS.dormant
    : !bundle.dns.resolves
      ? RECHECK_INTERVALS_HOURS.dormant
      : scored.tier === 'low'
        ? RECHECK_INTERVALS_HOURS.quiet
        : RECHECK_INTERVALS_HOURS.active;

  const { error: cErr } = await db
    .from('candidates')
    .update({
      status: retired ? 'retired' : 'verified',
      publish_state: publishState,
      recheck_count: bundle.dns.resolves ? 0 : candidate.recheck_count + 1,
      next_recheck_at: new Date(Date.now() + intervalHours * 3600_000).toISOString()
    })
    .eq('id', candidate.id);
  if (cErr) throw new Error(`candidate update failed: ${cErr.message}`);

  return {
    domain: candidate.domain,
    score: scored.score,
    tier: scored.tier,
    publishState,
    resolves: bundle.dns.resolves,
    retired
  };
}

/** Candidates due for a look: never-verified first, then oldest due. */
export async function loadDueCandidates(
  db: SupabaseClient,
  limit: number
): Promise<Candidate[]> {
  const { data, error } = await db
    .from('candidates')
    .select('*')
    .neq('status', 'retired')
    .neq('publish_state', 'cleared')
    .lte('next_recheck_at', new Date().toISOString())
    .order('status', { ascending: true }) // 'new' sorts before 'verified'
    .order('next_recheck_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`could not load due candidates: ${error.message}`);
  return (data ?? []) as Candidate[];
}
