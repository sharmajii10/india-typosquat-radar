import { checkAsn } from '@/lib/verify/asn';
import { checkContent } from '@/lib/verify/content';
import { checkDns } from '@/lib/verify/dns';
import { lookupRdap } from '@/lib/verify/rdap';
import type { VerificationBundle } from '@/lib/types';

export { checkAsn, checkContent, checkDns, lookupRdap };

/**
 * Run the full verification pass for one domain, in priority order.
 *
 * The ordering is not cosmetic - it is a cost gate. DNS is cheap and answers the
 * question that makes every later check worth doing. If the domain does not
 * resolve, the content fetch is skipped entirely (there is nothing to fetch),
 * and we save the most expensive call in the pipeline.
 *
 * RDAP runs in parallel with DNS because it is independent of resolution: a
 * registered-but-unpointed domain still has a creation date, and knowing it was
 * registered four hours ago is useful even when it is not yet live.
 */
export async function verifyDomain(
  domain: string,
  brandTerms: string[],
  deadlineAt: number
): Promise<VerificationBundle> {
  // DNS and RDAP run concurrently: RDAP is independent of resolution, since a
  // registered-but-unpointed domain still has a creation date. They are network
  // calls to unrelated hosts, so the earlier DNS-concurrency problem (four
  // queries sharing one resolver) does not apply here.
  const [dns, rdap] = await Promise.all([
    checkDns(domain, deadlineAt),
    lookupRdap(domain, deadlineAt)
  ]);

  // Content check only where there is something to fetch.
  const content = await checkContent({
    domain,
    brandTerms,
    aRecords: dns.aRecords,
    deadlineAt
  });

  const asn = await checkAsn(dns.aRecords);

  return { dns, rdap, content, asn };
}

/** Shape a verification bundle into a row for the `verifications` table. */
export function toVerificationRow(candidateId: string, bundle: VerificationBundle) {
  return {
    candidate_id: candidateId,
    checked_at: new Date().toISOString(),

    resolves: bundle.dns.resolves,
    a_records: bundle.dns.aRecords,
    has_mx: bundle.dns.hasMx,
    ns_records: bundle.dns.nsRecords,

    registrar: bundle.rdap.registrar,
    domain_created_at: bundle.rdap.createdAt,
    domain_age_days: bundle.rdap.ageDays,
    rdap_status: bundle.rdap.statuses,
    rdap_ok: bundle.rdap.ok,

    http_status: bundle.content.httpStatus,
    final_url: bundle.content.finalUrl,
    page_title: bundle.content.title,
    has_password_field: bundle.content.hasPasswordField,
    brand_terms_on_page: bundle.content.brandTermsOnPage,
    form_posts_offsite: bundle.content.formPostsOffsite,
    looks_parked: bundle.content.looksParked,
    content_risk_score: bundle.content.contentRiskScore,
    content_error: bundle.content.error ?? null,

    ip_address: bundle.asn.ip,
    asn: bundle.asn.asn,
    asn_org: bundle.asn.asnOrg,
    asn_reputation_score: bundle.asn.reputationScore,

    error: bundle.dns.error ?? bundle.rdap.error ?? null
  };
}
