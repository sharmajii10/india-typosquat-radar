import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_HINT,
  SUPABASE_PUBLIC_KEYS,
  SUPABASE_SECRET_KEYS,
  SUPABASE_URL_KEYS,
  hasEnv,
  requireEnv
} from '@/lib/env';

/**
 * Two clients, deliberately separate.
 *
 *  - `publicClient()` uses the PUBLISHABLE key (formerly the anon key) and is
 *    subject to Row Level Security. Read paths that serve the browser use it,
 *    so a mistake in a route handler still cannot leak a low-tier candidate:
 *    the policies in supabase/migrations/0002_rls.sql make those rows invisible
 *    to this key.
 *
 *  - `serviceClient()` uses the SECRET key (formerly the service_role key). It
 *    bypasses RLS entirely and is only ever constructed inside job routes. It
 *    throws if the key is missing, so a misconfigured deploy fails loudly
 *    instead of silently writing nothing.
 *
 * Which dashboard tab those come from, and the legacy names, are documented in
 * lib/env.ts.
 */

let _public: SupabaseClient | null = null;
let _service: SupabaseClient | null = null;

export function publicClient(): SupabaseClient {
  if (_public) return _public;
  _public = createClient(
    requireEnv(SUPABASE_URL_KEYS, SUPABASE_HINT),
    requireEnv(SUPABASE_PUBLIC_KEYS, SUPABASE_HINT),
    { auth: { persistSession: false } }
  );
  return _public;
}

export function serviceClient(): SupabaseClient {
  if (_service) return _service;
  _service = createClient(
    requireEnv(SUPABASE_URL_KEYS, SUPABASE_HINT),
    requireEnv(SUPABASE_SECRET_KEYS, SUPABASE_HINT),
    { auth: { persistSession: false } }
  );
  return _service;
}

/** True when the app has enough configuration to talk to the database.
 *  Lets pages render an honest "not configured yet" state during first setup
 *  instead of throwing a 500 at someone following the README. */
export function isConfigured(): boolean {
  return hasEnv(SUPABASE_URL_KEYS) && hasEnv(SUPABASE_PUBLIC_KEYS);
}

export function hasServiceKey(): boolean {
  return hasEnv(SUPABASE_SECRET_KEYS);
}

/** Records a job run for observability, and - just as importantly - guarantees
 *  a database write on every scheduled invocation. That write is what keeps a
 *  Supabase free-tier project from pausing after 7 idle days. */
export async function recordJobRun(
  job: string,
  fn: () => Promise<Record<string, unknown>>
): Promise<{ ok: boolean; stats: Record<string, unknown>; error?: string }> {
  const db = serviceClient();
  const started = new Date().toISOString();
  const { data: run } = await db
    .from('job_runs')
    .insert({ job, started_at: started })
    .select('id')
    .single();

  try {
    const stats = await fn();
    if (run?.id) {
      await db
        .from('job_runs')
        .update({ finished_at: new Date().toISOString(), ok: true, stats })
        .eq('id', run.id);
    }
    return { ok: true, stats };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (run?.id) {
      await db
        .from('job_runs')
        .update({ finished_at: new Date().toISOString(), ok: false, error: message })
        .eq('id', run.id);
    }
    return { ok: false, stats: {}, error: message };
  }
}
