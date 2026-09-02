import type { SupabaseClient } from '@supabase/supabase-js';
import { RECHECK_INTERVALS_HOURS } from '@/lib/config';
import { matchCertName } from '@/lib/matching/match';
import type { Brand, CertSighting } from '@/lib/types';

/**
 * Turn raw certificate sightings into candidate rows.
 *
 * Everything written here starts at `publish_state = 'hidden'`. Nothing reaches
 * the public feed from this step - a candidate only becomes visible after it has
 * been verified and scored, and only if it clears the confidence gate. That
 * ordering is load-bearing: the matcher is intentionally permissive, so the
 * database must never treat a match as a finding.
 */

export interface IngestResult {
  seen: number;
  matched: number;
  inserted: number;
  updated: number;
  skippedAllowlisted: number;
}

export async function ingestSightings(
  db: SupabaseClient,
  sightings: CertSighting[],
  brands: Brand[],
  allowlist: Set<string>
): Promise<IngestResult> {
  const result: IngestResult = {
    seen: sightings.length,
    matched: 0,
    inserted: 0,
    updated: 0,
    skippedAllowlisted: 0
  };

  // Collapse to one row per domain first. A single certificate can carry dozens
  // of SANs and crt.sh returns overlapping certs, so without this we would issue
  // the same upsert many times per run.
  const byDomain = new Map<
    string,
    { match: NonNullable<ReturnType<typeof matchCertName>>; sighting: CertSighting }
  >();

  for (const sighting of sightings) {
    const match = matchCertName({ name: sighting.name, brands, allowlist });
    if (!match) {
      // Distinguish "allowlisted" from "did not look like anything" for the
      // job stats, so an over-broad allowlist is visible in the logs.
      if (allowlist.has(sighting.name)) result.skippedAllowlisted++;
      continue;
    }

    const existing = byDomain.get(match.domain);
    // Keep the earliest certificate for a domain within this batch - that is
    // the one closest to when the domain was actually stood up.
    if (
      !existing ||
      (sighting.loggedAt &&
        existing.sighting.loggedAt &&
        sighting.loggedAt < existing.sighting.loggedAt)
    ) {
      byDomain.set(match.domain, { match, sighting });
    }
  }

  result.matched = byDomain.size;
  if (byDomain.size === 0) return result;

  // Which of these do we already know about?
  const domains = [...byDomain.keys()];
  const { data: existingRows } = await db
    .from('candidates')
    .select('id, domain, times_seen')
    .in('domain', domains);

  const existingByDomain = new Map(
    (existingRows ?? []).map((r) => [r.domain as string, r as { id: string; times_seen: number }])
  );

  const inserts: Record<string, unknown>[] = [];

  for (const [domain, { match, sighting }] of byDomain) {
    const existing = existingByDomain.get(domain);

    if (existing) {
      // Known domain: refresh the sighting metadata, leave the verdict alone.
      await db
        .from('candidates')
        .update({
          last_seen_at: new Date().toISOString(),
          times_seen: existing.times_seen + 1,
          cert_issuer: sighting.issuer,
          cert_issued_at: sighting.notBefore ?? sighting.loggedAt
        })
        .eq('id', existing.id);
      result.updated++;
      continue;
    }

    inserts.push({
      domain,
      unicode_domain: match.unicodeDomain,
      matched_brand_id: match.brandId,
      matched_term: match.matchedTerm,
      match_kind: match.matchKind,
      edit_distance: match.editDistance,
      homoglyph_flag: match.homoglyphFlag,
      homoglyph_detail: match.homoglyphDetail,
      cert_issuer: sighting.issuer,
      cert_issued_at: sighting.notBefore ?? sighting.loggedAt,
      first_seen_at: sighting.loggedAt ?? new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      status: 'new',
      // Explicit, even though it is the column default. This is the line that
      // keeps unverified matches off the public feed, and it should be
      // impossible to miss when reading the ingest path.
      publish_state: 'hidden',
      // Verify promptly - a brand new certificate is the freshest lead we get.
      next_recheck_at: new Date(
        Date.now() + RECHECK_INTERVALS_HOURS.new * 3600_000 * 0.1
      ).toISOString()
    });
  }

  if (inserts.length > 0) {
    // `ignoreDuplicates` guards the race where two overlapping job runs both
    // decide a domain is new.
    const { data, error } = await db
      .from('candidates')
      .upsert(inserts, { onConflict: 'domain', ignoreDuplicates: true })
      .select('id');
    if (error) throw new Error(`candidate insert failed: ${error.message}`);
    result.inserted = data?.length ?? 0;
  }

  return result;
}

/** Load the allowlist as a fast lookup set, including every brand's own
 *  official domains. Called once per job run. */
export async function loadAllowlist(db: SupabaseClient, brands: Brand[]): Promise<Set<string>> {
  const set = new Set<string>();

  for (const brand of brands) {
    for (const d of brand.official_domains) set.add(d.toLowerCase().trim());
  }

  const { data } = await db.from('allowlist').select('domain');
  for (const row of data ?? []) set.add(String(row.domain).toLowerCase().trim());

  return set;
}

export async function loadActiveBrands(db: SupabaseClient): Promise<Brand[]> {
  const { data, error } = await db.from('brands').select('*').eq('active', true);
  if (error) throw new Error(`could not load brands: ${error.message}`);
  return (data ?? []) as Brand[];
}
