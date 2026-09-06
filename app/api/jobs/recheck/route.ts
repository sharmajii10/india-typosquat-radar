import { isAuthorizedJobRequest, unauthorized } from '@/lib/auth';
import {
  CANDIDATE_VERIFY_BUDGET_MS,
  INTER_REQUEST_DELAY_MS,
  JOB_SOFT_DEADLINE_MS,
  RECHECK_BATCH_SIZE
} from '@/lib/config';
import { recordJobRun, serviceClient } from '@/lib/db';
import { assessCandidate, loadDueCandidates } from '@/lib/pipeline/assess';
import { loadActiveBrands } from '@/lib/pipeline/ingest';
import type { Brand } from '@/lib/types';
import { deadlineIn, outOfTime, remainingMs } from '@/lib/util/deadline';

/**
 * POST /api/jobs/recheck
 *
 * Verifies and re-scores a batch of candidates that are due. This is both the
 * first-pass verification for freshly ingested domains and the ongoing recheck
 * loop for known ones - they are the same operation, which is deliberate:
 * a candidate is never judged once and filed away.
 *
 * That matters most for the dormant majority. A lookalike domain registered
 * today and left unpointed will sit at low tier for weeks, then get a DNS record
 * and a login page one morning. Only a recheck loop catches that; a one-shot
 * pipeline would have written it off on day one.
 *
 * Rechecking is also what un-publishes things. A domain that gets taken down
 * stops resolving, loses the resolution and content signals, drops below the
 * threshold, and moves back off the public feed on its own.
 */

// No `runtime` export: Node.js is the default in Next 16 and the Edge runtime is
// deprecated, so the framework's own guidance is to omit it. This route needs the
// Node runtime regardless - it uses node:dns, node:crypto and outbound fetch.
export const dynamic = 'force-dynamic';

/** Vercel Hobby's ceiling; the job budget sits well below it. */
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  if (!isAuthorizedJobRequest(req)) return unauthorized();

  const started = Date.now();
  const deadlineAt = deadlineIn(JOB_SOFT_DEADLINE_MS);
  const url = new URL(req.url);
  const limit = clamp(Number(url.searchParams.get('limit') ?? RECHECK_BATCH_SIZE), 1, 100);

  const outcome = await recordJobRun('recheck', async () => {
    const db = serviceClient();

    const brands = await loadActiveBrands(db);
    const brandsById = new Map<string, Brand>(brands.map((b) => [b.id, b]));

    const due = await loadDueCandidates(db, limit);

    const results: Array<{ domain: string; score: number; tier: string; state: string }> = [];
    const errors: Array<{ domain: string; error: string }> = [];
    let published = 0;
    let queuedForReview = 0;
    let ranOutOfTime = false;

    for (const candidate of due) {
      // Refuse to start a candidate there is no time to finish. One verification
      // is up to four DNS lookups, an RDAP call and two HTTP fetches, so
      // starting one with ten seconds left is how the function gets killed
      // mid-write. Anything not reached stays due for the next run.
      if (outOfTime(deadlineAt, CANDIDATE_VERIFY_BUDGET_MS)) {
        ranOutOfTime = true;
        break;
      }

      const brand = brandsById.get(candidate.matched_brand_id);
      if (!brand) {
        errors.push({ domain: candidate.domain, error: 'brand not found or inactive' });
        continue;
      }

      try {
        const result = await assessCandidate(db, candidate, brand, deadlineAt);
        results.push({
          domain: result.domain,
          score: result.score,
          tier: result.tier,
          state: result.publishState
        });
        if (result.publishState === 'published') published++;
        if (result.publishState === 'pending_review') queuedForReview++;
      } catch (err) {
        errors.push({
          domain: candidate.domain,
          error: err instanceof Error ? err.message : String(err)
        });
      }

      // Politeness between outbound requests to different hosts.
      await delay(INTER_REQUEST_DELAY_MS);
    }

    return {
      due: due.length,
      checked: results.length,
      stoppedEarlyForTime: ranOutOfTime,
      budgetLeftMs: remainingMs(deadlineAt),
      published,
      queuedForReview,
      results,
      errors,
      elapsedMs: Date.now() - started
    };
  });

  return Response.json(outcome, { status: outcome.ok ? 200 : 500 });
}

export async function GET(req: Request): Promise<Response> {
  return POST(req);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
