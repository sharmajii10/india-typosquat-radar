import type { AsnResult } from '@/lib/types';

/**
 * Verification signal 5: hosting / ASN reputation.
 *
 * DELIBERATELY A STUB FOR MVP, and it is worth being explicit about why rather
 * than quietly leaving a gap.
 *
 * The signal itself is sound: a meaningful share of phishing concentrates on a
 * small number of bulletproof or abuse-tolerant networks, so knowing the ASN
 * behind a domain is genuinely informative. The problem is the reputation half.
 * Every current source is one of:
 *
 *   - Paid (Spamhaus ASN-DROP's commercial feeds, IPQS, Team Cymru's
 *     commercial products) - excluded by the zero-cost constraint.
 *   - Free but licence-restricted for redistribution, which matters because
 *     this project publishes its evidence.
 *   - Free but stale, and a stale ASN list mostly punishes cheap hosting rather
 *     than actual abuse. That is a false-positive generator aimed squarely at
 *     small Indian hosting providers, which is exactly the failure mode this
 *     project cannot afford.
 *
 * So: we resolve the IP and record it, we leave the reputation score null, and
 * the scorer contributes zero points for hosting. When a suitable free source is
 * wired in, only `reputationScore` and the weight in lib/scoring/weights.ts need
 * to change - nothing else in the pipeline knows the difference.
 *
 * Candidate free sources to evaluate for Phase 2:
 *   - Team Cymru's IP-to-ASN DNS service (free, no key) for ASN attribution.
 *     Attribution only, no reputation.
 *   - Spamhaus DROP / ASN-DROP public lists, checked against their licence.
 *   - Deriving reputation internally: once this project has months of labelled
 *     data, the ASNs that repeatedly host confirmed phishing here are a better
 *     and freely-usable reputation source than anything bought in.
 */
export async function checkAsn(aRecords: string[]): Promise<AsnResult> {
  const ip = aRecords.find((a) => !a.includes(':')) ?? aRecords[0] ?? null;

  return {
    ip,
    asn: null,
    asnOrg: null,
    // null, not 0. Zero would mean "we looked and it is clean"; null means
    // "we did not look". The scorer distinguishes the two.
    reputationScore: null
  };
}
