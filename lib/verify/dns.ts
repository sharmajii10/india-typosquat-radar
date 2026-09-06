import { Resolver } from 'node:dns/promises';
import { DNS_TIMEOUT_MS } from '@/lib/config';
import { boundedTimeout } from '@/lib/util/deadline';
import type { DnsResult } from '@/lib/types';

/**
 * Verification signal 1: does the domain resolve at all?
 *
 * This is the cheapest check in the pipeline and the highest value one. A large
 * share of registered lookalike domains are never pointed at anything - they are
 * bulk registrations, defensive holds, or kits that were abandoned before
 * deployment. A domain with no A record is not currently phishing anyone, so it
 * has no business on a public feed no matter how bad its name looks.
 *
 * MX is collected alongside because a lookalike with mail configured is set up
 * for the email half of the attack (the lure, or business email compromise),
 * which is a meaningfully different posture from a parked name.
 *
 * NS is collected because it survives when A records are pulled, so it
 * distinguishes "registered but never configured" from "was live, now taken
 * down" on recheck.
 */

/**
 * Lookups run SEQUENTIALLY, and that is a correctness fix rather than caution.
 *
 * The first version fired all four queries concurrently through one shared
 * `Resolver`. Against `hdfcbank.com` that returned no MX and no NS records -
 * both of which the domain demonstrably has. Running the identical queries one
 * at a time returns them correctly every time. Giving each query its own
 * `Resolver` helped with NS but MX still came back empty under concurrency.
 *
 * The failure mode is the dangerous kind: an empty answer is indistinguishable
 * from a genuine absence, so a dropped MX response silently removes a real
 * scoring signal and nothing anywhere logs an error. Wrong-but-quiet is much
 * worse here than slow, because the answer feeds a published accusation.
 *
 * Cost of the fix: roughly 150ms extra per candidate, against a per-candidate
 * budget already dominated by one RDAP call and one HTTP fetch. Not the
 * bottleneck.
 *
 * `tries: 2` for the same reason - DNS over UDP drops packets often enough that
 * a single attempt makes results non-deterministic.
 */
function makeResolver(timeoutMs: number): Resolver {
  return new Resolver({ timeout: timeoutMs, tries: 2 });
}

/**
 * `deadlineAt` is the job's absolute budget. Each lookup shrinks its timeout to
 * what is left, so four sequential lookups against an unresponsive nameserver
 * cannot outlast the function invocation.
 */
export async function checkDns(domain: string, deadlineAt: number): Promise<DnsResult> {
  // Reserve room for the RDAP and content checks that follow this one.
  const perLookup = () => boundedTimeout(deadlineAt, DNS_TIMEOUT_MS);

  const lookup = async <T>(fn: (r: Resolver) => Promise<T>) => {
    const timeoutMs = perLookup();
    if (timeoutMs <= 0) return { value: null, code: 'BUDGET_EXHAUSTED' };
    return safe(() => fn(makeResolver(timeoutMs)));
  };

  const a = await lookup((r) => r.resolve4(domain));
  const aaaa = await lookup((r) => r.resolve6(domain));
  const mx = await lookup((r) => r.resolveMx(domain));
  const ns = await lookup((r) => r.resolveNs(domain));

  const aRecords = [...(a.value ?? []), ...(aaaa.value ?? [])];
  const nsRecords = ns.value ?? [];

  // NXDOMAIN specifically means the name does not exist. Any other error
  // (SERVFAIL, timeout) means we do not know, which is not the same thing and
  // must not be scored as if the domain were confirmed dead.
  const nxdomain = a.code === 'ENOTFOUND' && ns.code === 'ENOTFOUND';
  const unknown = !nxdomain && aRecords.length === 0 && nsRecords.length === 0;

  return {
    resolves: aRecords.length > 0,
    aRecords,
    hasMx: (mx.value ?? []).length > 0,
    nsRecords: nsRecords.map((n) => String(n)),
    error: unknown ? (a.code ?? 'lookup failed') : undefined
  };
}

async function safe<T>(
  fn: () => Promise<T>
): Promise<{ value: T | null; code: string | null }> {
  try {
    return { value: await fn(), code: null };
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : 'ERROR';
    return { value: null, code };
  }
}
