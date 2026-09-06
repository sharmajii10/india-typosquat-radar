import { isAuthorizedJobRequest, unauthorized } from '@/lib/auth';
import { recordJobRun, serviceClient } from '@/lib/db';
import { ingestSightings, loadActiveBrands, loadAllowlist } from '@/lib/pipeline/ingest';
import type { CertSighting } from '@/lib/types';

/**
 * POST /api/jobs/ingest
 *
 * Accepts a batch of certificate sightings gathered elsewhere and runs them
 * through the normal matcher and ingest path. Used by the CT log scanner, which
 * runs inside GitHub Actions rather than here.
 *
 * WHY THE SCANNER DOES NOT WRITE TO THE DATABASE DIRECTLY: that would mean
 * putting the Supabase secret key into GitHub Actions secrets. Today GitHub
 * holds only JOB_SECRET, which can trigger scans and nothing else, while the
 * key that bypasses Row Level Security exists solely in Vercel. Keeping that
 * split is worth one HTTP round trip.
 *
 * The cursor advance and the ingest happen in the same request on purpose. If
 * the scanner recorded its position separately and that call failed, the entries
 * in between would be skipped permanently - and silently, because a scanner that
 * skips entries looks exactly like one finding nothing.
 */

// No `runtime` export: Node.js is the default in Next 16 and the Edge runtime is
// deprecated. Needed here regardless, for the matcher and database writes.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Batch ceiling. The scanner filters aggressively before posting, so a batch
 *  larger than this means the filter is broken rather than that the internet
 *  got busy. */
const MAX_SIGHTINGS_PER_BATCH = 2000;

interface IngestBody {
  log?: {
    url?: string;
    description?: string;
    operator?: string;
    treeSize?: number;
  };
  /** Index to resume from next time. */
  nextIndex?: number;
  entriesRead?: number;
  error?: string;
  sightings?: Array<{
    name?: string;
    issuer?: string | null;
    notBefore?: string | null;
    loggedAt?: string | null;
  }>;
}

export async function POST(req: Request): Promise<Response> {
  if (!isAuthorizedJobRequest(req)) return unauthorized();

  let body: IngestBody;
  try {
    body = (await req.json()) as IngestBody;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const logUrl = typeof body.log?.url === 'string' ? body.log.url : '';
  if (!logUrl) {
    return Response.json({ error: 'log.url is required' }, { status: 400 });
  }

  const rawSightings = Array.isArray(body.sightings) ? body.sightings : [];
  if (rawSightings.length > MAX_SIGHTINGS_PER_BATCH) {
    return Response.json(
      {
        error: `batch of ${rawSightings.length} exceeds the ${MAX_SIGHTINGS_PER_BATCH} ceiling`
      },
      { status: 413 }
    );
  }

  const sightings: CertSighting[] = rawSightings
    .filter((s): s is { name: string } & typeof s => typeof s.name === 'string' && s.name.length > 0)
    .map((s) => ({
      name: s.name,
      issuer: s.issuer ?? null,
      notBefore: s.notBefore ?? null,
      loggedAt: s.loggedAt ?? null,
      source: 'certstream' as const
    }));

  const outcome = await recordJobRun('ingest', async () => {
    const db = serviceClient();

    const brands = await loadActiveBrands(db);
    const allowlist = await loadAllowlist(db, brands);
    const ingest = await ingestSightings(db, sightings, brands, allowlist);

    // Record where the scanner got to, in the same request that stored what it
    // found. An advance without the ingest would skip entries silently.
    const cursorUpdate: Record<string, unknown> = {
      url: logUrl,
      description: body.log?.description ?? null,
      operator: body.log?.operator ?? null,
      tree_size: Number.isFinite(body.log?.treeSize) ? body.log?.treeSize : null,
      last_scanned_at: new Date().toISOString(),
      last_error: body.error ?? null
    };
    if (Number.isFinite(body.nextIndex)) cursorUpdate.last_index = body.nextIndex;

    const { data: existing } = await db
      .from('ct_logs')
      .select('entries_scanned, sightings_found')
      .eq('url', logUrl)
      .maybeSingle();

    cursorUpdate.entries_scanned =
      Number(existing?.entries_scanned ?? 0) + Number(body.entriesRead ?? 0);
    cursorUpdate.sightings_found =
      Number(existing?.sightings_found ?? 0) + sightings.length;

    const { error: cursorErr } = await db
      .from('ct_logs')
      .upsert(cursorUpdate, { onConflict: 'url' });
    if (cursorErr) throw new Error(`cursor update failed: ${cursorErr.message}`);

    return {
      log: logUrl,
      nextIndex: body.nextIndex ?? null,
      entriesRead: body.entriesRead ?? 0,
      submitted: sightings.length,
      ...ingest
    };
  });

  return Response.json(outcome, { status: outcome.ok ? 200 : 500 });
}

/**
 * GET /api/jobs/ingest - what the scanner needs before it starts.
 *
 * Returns the cursor for every known log plus the watchlist terms, so the
 * scanner can filter locally. Filtering at the scanner is what makes reading
 * the firehose viable at all: the logs carry millions of certificates a day and
 * well under one in a thousand is worth posting back.
 */
export async function GET(req: Request): Promise<Response> {
  if (!isAuthorizedJobRequest(req)) return unauthorized();

  const db = serviceClient();

  const [logsResult, brands] = await Promise.all([
    db
      .from('ct_logs')
      .select('url, description, operator, enabled, last_index, tree_size, last_scanned_at')
      .order('last_scanned_at', { ascending: true, nullsFirst: true }),
    loadActiveBrands(db)
  ]);

  // A missing ct_logs table means migration 0003 has not been run yet. Report
  // that plainly instead of failing: the scanner can still work, it just starts
  // every log from the head each time, and the operator needs to be told why
  // rather than left with an opaque error.
  const migrationMissing = Boolean(
    logsResult.error && /relation .*ct_logs.* does not exist|schema cache/i.test(logsResult.error.message)
  );
  const logs = logsResult.data ?? [];

  const terms = [...new Set(brands.flatMap((b) => b.match_terms))].sort(
    (a, b) => b.length - a.length
  );

  return Response.json({
    logs,
    terms,
    brandCount: brands.length,
    ...(migrationMissing
      ? {
          warning:
            'The ct_logs table does not exist, so scan positions cannot be saved. ' +
            'Run supabase/migrations/0003_ct_logs.sql. Until then every scan ' +
            'restarts from the head of each log and re-reads the same entries.'
        }
      : {}),
    ...(logsResult.error && !migrationMissing ? { error: logsResult.error.message } : {})
  });
}
