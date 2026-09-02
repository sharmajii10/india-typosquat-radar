import { isAuthorizedJobRequest, unauthorized } from '@/lib/auth';
import { JOB_SOFT_DEADLINE_MS, POLL_BRANDS_PER_RUN } from '@/lib/config';
import { crtshDelay, fetchRecentCerts } from '@/lib/ct/crtsh';
import { recordJobRun, serviceClient } from '@/lib/db';
import { ingestSightings, loadActiveBrands, loadAllowlist } from '@/lib/pipeline/ingest';
import type { CertSighting } from '@/lib/types';

/**
 * POST /api/jobs/poll
 *
 * Polls crt.sh for a rotating slice of the brand watchlist and writes any name
 * matches as hidden candidates. Called every 10-15 minutes by the GitHub Actions
 * workflow in .github/workflows/radar.yml.
 *
 * Why not Vercel Cron: on the Hobby plan cron is limited to one run per day, and
 * that run only fires somewhere inside its scheduled hour. Neither is compatible
 * with a feed that claims to be live. GitHub Actions allows a 5-minute floor on
 * public repositories at no cost, so the schedule lives there and this route is
 * just a secured endpoint it calls.
 *
 * Side benefit worth stating explicitly: every invocation reads and writes the
 * database, which resets Supabase's 7-day free-tier inactivity timer. No
 * separate keep-alive service is needed.
 */

// No `runtime` export: Node.js is the default in Next 16 and the Edge runtime is
// deprecated, so the framework's own guidance is to omit it. This route needs the
// Node runtime regardless - it uses node:dns, node:crypto and outbound fetch.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  if (!isAuthorizedJobRequest(req)) return unauthorized();

  const started = Date.now();
  const url = new URL(req.url);
  const lookbackHours = clamp(Number(url.searchParams.get('lookbackHours') ?? 6), 1, 168);
  const brandLimit = clamp(
    Number(url.searchParams.get('brands') ?? POLL_BRANDS_PER_RUN),
    1,
    25
  );

  const outcome = await recordJobRun('poll', async () => {
    const db = serviceClient();

    const brands = await loadActiveBrands(db);
    if (brands.length === 0) {
      return { note: 'no active brands - run the seed script', brandsPolled: 0 };
    }

    const allowlist = await loadAllowlist(db, brands);

    // Round-robin: least recently polled first, so every brand gets covered over
    // a handful of runs without any single run exceeding the function's time
    // budget. With 15 brands at 4 per run every 10 minutes, a full sweep takes
    // about 40 minutes.
    const rotation = [...brands].sort((a, b) => {
      const at = a.last_polled_at ? Date.parse(a.last_polled_at) : 0;
      const bt = b.last_polled_at ? Date.parse(b.last_polled_at) : 0;
      return at - bt;
    });

    const sightings: CertSighting[] = [];
    const polled: string[] = [];
    const failures: Array<{ brand: string; term: string; error: string }> = [];
    // Terms crt.sh answered with an empty array. Tracked separately from
    // failures because they arrive as HTTP 200 and would otherwise be
    // indistinguishable from a healthy run that simply found nothing new.
    const emptyTerms: string[] = [];
    let termsQueried = 0;
    let termsWithRows = 0;

    outer: for (const brand of rotation.slice(0, brandLimit)) {
      // Query the brand's two most specific terms rather than all of them.
      // Longer terms are more selective, which keeps crt.sh response sizes sane
      // and avoids hammering a free community service with broad wildcards.
      const terms = [...brand.match_terms]
        .sort((a, b) => b.length - a.length)
        .filter((t) => t.length >= 4)
        .slice(0, 2);

      for (const term of terms) {
        if (Date.now() - started > JOB_SOFT_DEADLINE_MS) break outer;

        try {
          const found = await fetchRecentCerts(term, { lookbackHours });
          sightings.push(...found.sightings);
          termsQueried++;
          if (found.rawRowCount > 0) termsWithRows++;
          else emptyTerms.push(term);
        } catch (err) {
          // One bad term must not sink the run. crt.sh is frequently slow and
          // occasionally down; the next scheduled run picks the brand back up.
          failures.push({
            brand: brand.slug,
            term,
            error: err instanceof Error ? err.message : String(err)
          });
        }

        await crtshDelay();
      }

      polled.push(brand.slug);
      await db
        .from('brands')
        .update({ last_polled_at: new Date().toISOString() })
        .eq('id', brand.id);
    }

    const ingest = await ingestSightings(db, sightings, brands, allowlist);

    // If every single term crt.sh answered came back with no certificates at
    // all - not "none recently", none ever - the source is degraded rather than
    // the internet being quiet. Watchlist terms like `hdfcbank` have thousands
    // of historical certificates, so zero is not a real answer.
    //
    // This is called out explicitly because the failure is otherwise invisible:
    // the run succeeds, no errors are recorded, and the feed just never fills.
    const upstreamLooksDegraded = termsQueried > 0 && termsWithRows === 0;

    return {
      brandsPolled: polled.length,
      brands: polled,
      termsQueried,
      termsWithRows,
      lookbackHours,
      sightings: sightings.length,
      ...ingest,
      failures,
      emptyTerms,
      upstreamLooksDegraded,
      ...(upstreamLooksDegraded
        ? {
            warning:
              'crt.sh returned no certificates for any queried term. It answers ' +
              'HTTP 200 with an empty array while degraded, so this is almost ' +
              'certainly an upstream outage rather than a genuine absence of ' +
              'results. Nothing was ingested. The next scheduled run retries ' +
              'against an overlapping lookback window, so no data is lost.'
          }
        : {}),
      elapsedMs: Date.now() - started
    };
  });

  return Response.json(outcome, { status: outcome.ok ? 200 : 500 });
}

/** GET is allowed so the endpoint can be smoke-tested from a browser or curl
 *  with the secret as a query parameter. Same auth, same work. */
export async function GET(req: Request): Promise<Response> {
  return POST(req);
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
