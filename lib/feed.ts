import type { FeedItem, Signal, Tier } from '@/lib/types';

/**
 * Shape a `public_feed` row into the public API contract.
 *
 * The one rule that governs everything here: LANGUAGE MUST MATCH CONFIDENCE.
 *
 * A high-tier item is stated as a detection. A medium-tier item is stated as
 * unconfirmed and under review, and `confirmed` is false so no client can render
 * it as an accusation by accident. Nothing below medium ever reaches this
 * function, because the view it reads from does not contain low-tier rows.
 */

export interface FeedRow {
  id: string;
  domain: string;
  unicode_domain: string | null;
  first_seen_at: string;
  last_seen_at: string;
  edit_distance: number;
  homoglyph_flag: boolean;
  match_kind: string;
  matched_term: string;
  cert_issuer: string | null;
  cert_issued_at: string | null;
  publish_state: string;
  brand_name: string;
  brand_slug: string;
  brand_category: string;
  /** First entry of the brand's official_domains, added in migration 0004.
   *  Optional on the type so a deployment that has not run that migration yet
   *  degrades to "no comparison shown" instead of throwing. */
  brand_official_domain?: string | null;
  score: number | null;
  tier: string | null;
  contributing_signals: Signal[] | null;
  scored_at: string | null;
  resolves: boolean | null;
  has_password_field: boolean | null;
  domain_age_days: number | null;
  registrar: string | null;
  http_status: number | null;
  looks_parked: boolean | null;
  last_checked_at: string | null;
}

export function toFeedItem(row: FeedRow): FeedItem {
  const tier = (row.tier ?? 'medium') as Tier;
  const confirmed = row.publish_state === 'published' && tier === 'high';

  return {
    id: row.id,
    domain: row.domain,
    unicodeDomain: row.unicode_domain,
    brand: {
      name: row.brand_name,
      slug: row.brand_slug,
      category: row.brand_category as FeedItem['brand']['category'],
      officialDomain: row.brand_official_domain ?? null
    },
    tier,
    score: row.score ?? 0,
    confirmed,
    statusLabel: statusLabel(row.publish_state, tier),
    firstSeenAt: row.first_seen_at,
    lastCheckedAt: row.last_checked_at,
    certIssuer: row.cert_issuer,
    certIssuedAt: row.cert_issued_at,
    resolves: row.resolves,
    hasPasswordField: row.has_password_field,
    domainAgeDays: row.domain_age_days,
    registrar: row.registrar,
    homoglyphFlag: row.homoglyph_flag,
    editDistance: row.edit_distance,
    signals: row.contributing_signals ?? []
  };
}

/**
 * The words the public sees. Deliberately blunt about uncertainty.
 *
 * "High confidence" is the strongest phrasing used anywhere in this project.
 * Not "confirmed phishing", not "malicious" - the pipeline observes behaviour,
 * it does not adjudicate intent, and the copy should not claim otherwise.
 */
export function statusLabel(publishState: string, tier: Tier): string {
  if (publishState === 'pending_review') return 'Unconfirmed - under review';
  if (tier === 'high') return 'High confidence';
  if (tier === 'medium') return 'Unconfirmed - under review';
  return 'Low confidence';
}

/** "reported 12 minutes ago" - relative time for the feed. */
export function relativeTime(iso: string | null): string {
  if (!iso) return 'unknown';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';

  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;

  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}
