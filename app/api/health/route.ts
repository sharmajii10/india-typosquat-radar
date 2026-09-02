import { hasServiceKey, isConfigured, publicClient } from '@/lib/db';
import {
  SUPABASE_PUBLIC_KEYS,
  SUPABASE_SECRET_KEYS,
  SUPABASE_URL_KEYS,
  hasEnv
} from '@/lib/env';

/**
 * GET /api/health - is this deployment actually configured and working?
 *
 * Built after a deploy came up returning "not_configured" with no way to tell
 * WHICH variable was missing. Diagnosing that from the outside meant guessing,
 * and guessing at a production config problem is how an unattended service
 * stays broken for a week.
 *
 * WHAT IT DOES NOT DO: report any value, or any prefix of any value. Every
 * config field below is a boolean saying whether something is set. The variable
 * NAMES are public knowledge already - they are in .env.example in a public
 * repo - so listing which name satisfied a slot leaks nothing.
 *
 * Knowing whether a public instance is configured is not sensitive: a visitor
 * can already tell from the feed being empty. What this adds is telling the
 * operator WHY, which is the whole point.
 */

// No `runtime` export: Node.js is the default in Next 16 and the Edge runtime is
// deprecated, so the framework's own guidance is to omit it.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const config = {
    supabaseUrl: {
      set: hasEnv(SUPABASE_URL_KEYS),
      accepts: SUPABASE_URL_KEYS,
      satisfiedBy: which(SUPABASE_URL_KEYS)
    },
    supabasePublishableKey: {
      set: hasEnv(SUPABASE_PUBLIC_KEYS),
      accepts: SUPABASE_PUBLIC_KEYS,
      satisfiedBy: which(SUPABASE_PUBLIC_KEYS)
    },
    supabaseSecretKey: {
      set: hasServiceKey(),
      accepts: SUPABASE_SECRET_KEYS,
      satisfiedBy: which(SUPABASE_SECRET_KEYS)
    },
    jobSecret: {
      // The job routes refuse everything when this is unset, so an operator
      // seeing 401s from a correct secret needs to know it never arrived.
      set: Boolean(process.env.JOB_SECRET && process.env.JOB_SECRET.length >= 16),
      accepts: ['JOB_SECRET'],
      satisfiedBy: process.env.JOB_SECRET ? 'JOB_SECRET' : null
    }
  };

  const missing = Object.entries(config)
    .filter(([, v]) => !v.set)
    .map(([k]) => k);

  // Only probe the database when there is something to probe with.
  let database: Record<string, unknown> = { checked: false };
  if (isConfigured()) {
    try {
      const { count, error } = await publicClient()
        .from('brands')
        .select('id', { count: 'exact', head: true });
      database = error
        ? { checked: true, reachable: false, error: error.message }
        : { checked: true, reachable: true, brandsSeeded: count ?? 0 };
    } catch (err) {
      database = {
        checked: true,
        reachable: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  const ok = missing.length === 0 && database.reachable === true;

  return Response.json(
    {
      ok,
      missing,
      config,
      database,
      hint: buildHint(missing, database),
      checkedAt: new Date().toISOString()
    },
    {
      status: ok ? 200 : 503,
      headers: { 'cache-control': 'no-store' }
    }
  );
}

/** Which of the accepted names actually provided the value. Names only. */
function which(names: string[]): string | null {
  return names.find((n) => Boolean(process.env[n])) ?? null;
}

function buildHint(missing: string[], database: Record<string, unknown>): string {
  if (missing.length > 0) {
    return (
      `Not configured. Missing: ${missing.join(', ')}. On Vercel, check ` +
      'Settings -> Environment Variables and confirm each one is enabled for ' +
      'the Production environment specifically, not just Preview. Environment ' +
      'variable changes do not take effect until you redeploy.'
    );
  }
  if (database.reachable === false) {
    return (
      'Variables are set but the database rejected the connection. Check that ' +
      'the URL is the project origin with no /rest/v1 path and no trailing ' +
      'slash, and that the keys belong to that same project.'
    );
  }
  if (database.brandsSeeded === 0) {
    return 'Configured and connected, but the watchlist is empty. Run: npm run seed';
  }
  return 'Configured, connected, and seeded.';
}
