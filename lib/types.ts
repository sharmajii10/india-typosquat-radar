/** Shared types across matcher, verifier, scorer and API routes. */

export type BrandCategory = 'bank' | 'payment' | 'government' | 'other';
export type Tier = 'high' | 'medium' | 'low';
export type PublishState = 'hidden' | 'pending_review' | 'published' | 'cleared';
export type CandidateStatus = 'new' | 'verified' | 'retired';
export type MatchKind =
  | 'exact_token'
  | 'edit_distance'
  | 'homoglyph'
  | 'substring'
  | 'keyword_combo';

export interface Brand {
  id: string;
  name: string;
  slug: string;
  category: BrandCategory;
  official_domains: string[];
  aliases: string[];
  match_terms: string[];
  active: boolean;
  last_polled_at: string | null;
  created_at: string;
}

export interface Candidate {
  id: string;
  domain: string;
  unicode_domain: string | null;
  matched_brand_id: string;
  matched_term: string;
  match_kind: MatchKind;
  edit_distance: number;
  homoglyph_flag: boolean;
  homoglyph_detail: HomoglyphDetail | null;
  cert_issuer: string | null;
  cert_issued_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  times_seen: number;
  status: CandidateStatus;
  publish_state: PublishState;
  reviewed_at: string | null;
  reviewed_note: string | null;
  next_recheck_at: string;
  recheck_count: number;
  created_at: string;
}

export interface HomoglyphDetail {
  /** Characters that were folded to a Latin equivalent, with what they became. */
  substitutions: Array<{ from: string; to: string; codepoint: string }>;
  /** True when the label mixes more than one Unicode script - the classic
   *  IDN homograph pattern (e.g. Latin + Cyrillic in one word). */
  mixedScript: boolean;
  scripts: string[];
}

/** Raw certificate sighting from a CT source, before matching. */
export interface CertSighting {
  /** Domain exactly as it appeared in the certificate (may be a wildcard). */
  name: string;
  issuer: string | null;
  notBefore: string | null;
  loggedAt: string | null;
  source: 'crt.sh' | 'certstream';
}

/** A CertSighting that passed the matcher. */
export interface MatchResult {
  domain: string;
  unicodeDomain: string | null;
  brandId: string;
  brandSlug: string;
  matchedTerm: string;
  matchKind: MatchKind;
  editDistance: number;
  homoglyphFlag: boolean;
  homoglyphDetail: HomoglyphDetail | null;
  /** Phishing keywords found in the domain alongside the brand term. */
  keywords: string[];
  /** Human-readable one-liner, stored on the score's evidence trail. */
  explanation: string;
}

export interface DnsResult {
  resolves: boolean;
  aRecords: string[];
  hasMx: boolean;
  nsRecords: string[];
  error?: string;
}

export interface RdapResult {
  ok: boolean;
  registrar: string | null;
  createdAt: string | null;
  ageDays: number | null;
  statuses: string[];
  source: 'rdap' | 'rdap-bootstrap' | 'none';
  error?: string;
}

export interface ContentResult {
  attempted: boolean;
  httpStatus: number | null;
  finalUrl: string | null;
  title: string | null;
  hasPasswordField: boolean;
  brandTermsOnPage: string[];
  formPostsOffsite: boolean;
  looksParked: boolean;
  /** 0-100 from content signals alone, before global weighting. */
  contentRiskScore: number;
  error?: string;
}

export interface AsnResult {
  ip: string | null;
  asn: string | null;
  asnOrg: string | null;
  reputationScore: number | null;
}

export interface VerificationBundle {
  dns: DnsResult;
  rdap: RdapResult;
  content: ContentResult;
  asn: AsnResult;
}

/**
 * One itemised piece of evidence behind a score. Stored as JSON on
 * `risk_scores.contributing_signals` and rendered verbatim in the public
 * evidence panel, so `label` must read well to a non-technical visitor.
 */
export interface Signal {
  key: string;
  label: string;
  points: number;
  /** Which independent evidence category this belongs to. The high-confidence
   *  gate counts distinct categories, not individual signals, so that five
   *  restatements of "the name looks similar" never add up to a publication. */
  category: EvidenceCategory;
  detail?: string;
}

export type EvidenceCategory =
  | 'name'
  | 'infrastructure'
  | 'registration'
  | 'content'
  | 'certificate'
  | 'hosting'
  | 'mitigating';

export interface ScoreResult {
  score: number;
  tier: Tier;
  signals: Signal[];
  categories: EvidenceCategory[];
  weightsVersion: string;
  /** Set when a hard gate held the candidate below its numeric tier. */
  gateNote?: string;
}

/** Shape returned by /api/feed - the public contract. */
export interface FeedItem {
  id: string;
  domain: string;
  unicodeDomain: string | null;
  brand: {
    name: string;
    slug: string;
    category: BrandCategory;
    /**
     * The brand's canonical domain, for showing beside the flagged one.
     *
     * A reader who already knows what the real address looks like does not need
     * this project; a reader who does not is exactly who a typosquat is aimed
     * at. Null when the brand has no official domain recorded, which the UI
     * renders as nothing rather than as an empty link.
     */
    officialDomain: string | null;
  };
  tier: Tier;
  score: number;
  confirmed: boolean;
  statusLabel: string;
  firstSeenAt: string;
  lastCheckedAt: string | null;
  certIssuer: string | null;
  certIssuedAt: string | null;
  resolves: boolean | null;
  hasPasswordField: boolean | null;
  domainAgeDays: number | null;
  registrar: string | null;
  homoglyphFlag: boolean;
  editDistance: number;
  signals: Signal[];
}
