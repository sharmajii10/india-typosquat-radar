/**
 * Environment variable resolution, in one place.
 *
 * Deliberately has no imports, so the CLI scripts in `scripts/` can use it
 * without pulling in the Supabase client or anything else.
 *
 * ---------------------------------------------------------------------------
 * Supabase renamed its two API keys. The dashboard now has two tabs, and this
 * is the mapping between them:
 *
 *   "Publishable and secret API keys"   <- use this one
 *      Publishable key  sb_publishable_...   -> Postgres role `anon`
 *      Secret key       sb_secret_...        -> Postgres role `service_role`
 *
 *   "Legacy anon, service_role API keys"  <- still works, being phased out
 *      anon / public    eyJ...               -> Postgres role `anon`
 *      service_role     eyJ...               -> Postgres role `service_role`
 *
 * Both formats work with the client version pinned here, and both map to the
 * same two Postgres roles, so the Row Level Security policies in
 * supabase/migrations/0002_rls.sql apply identically either way. Prefer the new
 * keys: Supabase's own dashboard recommends them, and legacy keys can be
 * disabled per project.
 *
 * Each lookup below accepts either naming convention so that following either
 * Supabase's docs or this project's docs works.
 * ---------------------------------------------------------------------------
 */

export const SUPABASE_URL_KEYS = ['NEXT_PUBLIC_SUPABASE_URL'];

/** The publishable key, formerly the anon key. Ships to the browser, and is
 *  safe there ONLY because Row Level Security is configured. */
export const SUPABASE_PUBLIC_KEYS = [
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'
];

/** The secret key, formerly the service_role key. Bypasses Row Level Security
 *  entirely. Server-side only - never expose it to a browser. */
export const SUPABASE_SECRET_KEYS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY'
];

/** First non-empty value among `names`, or undefined. */
export function readEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

export function hasEnv(names: string[]): boolean {
  return readEnv(names) !== undefined;
}

/** Like `readEnv`, but throws a message that names every accepted variable
 *  rather than sending someone off to guess which one this project wanted. */
export function requireEnv(names: string[], hint?: string): string {
  const value = readEnv(names);
  if (value) return value;
  throw new Error(
    `Missing environment variable. Set one of: ${names.join(' or ')}.` +
      (hint ? ` ${hint}` : ' See .env.example for where to find it.')
  );
}

/** Where in the Supabase dashboard each key lives, for error messages. */
export const SUPABASE_HINT =
  'Supabase dashboard -> Project Settings -> API Keys -> "Publishable and secret API keys".';
