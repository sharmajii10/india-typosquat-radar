import { CRTSH_DELAY_MS, CRTSH_TIMEOUT_MS, SCANNER_USER_AGENT } from '@/lib/config';
import type { CertSighting } from '@/lib/types';
import { normalizeCertName } from '@/lib/util/domain';

/**
 * Certificate Transparency source: crt.sh.
 *
 * crt.sh is Sectigo's free public CT search. It is the right MVP source because
 * it needs no API key, no account and no payment, and it indexes every major
 * log. It is not a live stream - we poll it - which means detection latency is
 * the poll interval (10-15 minutes via GitHub Actions) rather than seconds.
 *
 * PHASE 2: a certstream-style websocket feed gives true real-time delivery and
 * removes the per-brand query fan-out entirely, because you filter the firehose
 * locally instead of asking crt.sh one question per brand. That does not fit
 * Vercel's serverless model though - a websocket consumer needs a long-lived
 * process. The free-tier-compatible shape would be a long-running job step
 * inside GitHub Actions that listens for a bounded window (say 5 minutes),
 * batches what it sees, POSTs it to /api/jobs/ingest, and exits. Deliberately
 * out of scope for MVP; the ingest path is already shaped to accept batches.
 *
 * RELIABILITY, stated plainly because it affects whether this thing works:
 * crt.sh is frequently unavailable. During development it returned HTTP 502 for
 * every query, across four different URL shapes, for an extended period. It is a
 * free community service run by Sectigo with no uptime obligation to anyone, and
 * building on it means accepting that. What this module does about it:
 *   - a small number of spaced retries, which clears most transient 502s;
 *   - a per-term failure is recorded and the run continues to the next brand;
 *   - the poll uses an overlapping lookback window rather than a cursor, so an
 *     entirely failed run loses nothing that the next run will not pick up.
 *
 * If crt.sh outages become sustained rather than intermittent, the free
 * alternatives worth building, in order of effort:
 *   1. crt.sh's public read-only PostgreSQL interface (crt.sh:5432, database
 *      certwatch, user `guest`). Same data, no key, and it often answers while
 *      the web front-end is returning 502 because the failures are usually in
 *      the web tier. Needs a Postgres client dependency.
 *   2. Reading CT logs directly from the log operators (Google, Cloudflare,
 *      Let's Encrypt). Free and keyless, but it is the whole firehose - you
 *      filter locally, which needs a long-running process rather than a
 *      serverless function. Fits the same GitHub Actions shape as the
 *      certstream upgrade described above.
 *
 * Politeness: every query is spaced by CRTSH_DELAY_MS, capped by a timeout, and
 * identifies itself honestly in the User-Agent.
 */

const CRTSH_ENDPOINT = 'https://crt.sh/';

/**
 * Response size ceiling. A broad term under a wildcard query can return tens of
 * megabytes of history. We are only interested in the last few hours, so a
 * response that large means the query is too broad to be useful - better to
 * skip it loudly than to spend the whole function budget parsing history.
 */
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

export interface CrtShRow {
  issuer_ca_id?: number;
  issuer_name?: string;
  common_name?: string;
  name_value?: string;
  id?: number;
  entry_timestamp?: string;
  not_before?: string;
  not_after?: string;
}

/**
 * The result of one crt.sh query.
 *
 * `rawRowCount` exists to separate two outcomes that look identical from the
 * outside but mean opposite things:
 *
 *   rawRowCount > 0, sightings 0  -> crt.sh answered, nothing new in the window.
 *                                    Normal and expected on most runs.
 *   rawRowCount = 0               -> crt.sh returned an EMPTY ARRAY. For a broad
 *                                    brand term like `hdfcbank`, which has
 *                                    thousands of historical certificates, this
 *                                    is not a real answer. It is what crt.sh
 *                                    returns while degraded.
 *
 * Without this distinction the pipeline reports a healthy run with zero results
 * while its only data source is broken, and the feed silently never fills.
 */
export interface CertQueryResult {
  sightings: CertSighting[];
  rawRowCount: number;
}

export interface PollOptions {
  /** Only return certificates first logged within this many hours. Keeps each
   *  run's working set small and bounded regardless of a term's total history. */
  lookbackHours: number;
  signal?: AbortSignal;
}

/**
 * How many times to attempt a single crt.sh query before giving up on it.
 *
 * This is not defensive boilerplate. crt.sh returns HTTP 502 from its front-end
 * routinely - during development every query across four different URL shapes
 * returned 502 for an extended stretch, then recovered on its own. Those are
 * front-end failures rather than "no results", and they usually clear within
 * seconds, so a couple of spaced retries converts most of them into successes.
 *
 * Kept to 3 because a run that spends its whole budget retrying one dead term
 * covers no brands at all, and a term skipped now is simply picked up by the
 * next scheduled run against an overlapping lookback window - nothing is lost.
 */
const CRTSH_ATTEMPTS = 3;

/** Backoff between attempts. Short, because the whole run is time-boxed. */
const CRTSH_RETRY_DELAY_MS = 2000;

/**
 * How many times to re-ask when crt.sh answers 200 with an empty array.
 *
 * Fewer than CRTSH_ATTEMPTS on purpose. Some narrow watchlist terms legitimately
 * have no certificates at all, and spending the whole run's budget re-asking
 * about them would starve the brands that do have results.
 */
const EMPTY_RESPONSE_ATTEMPTS = 2;

/** HTTP statuses worth retrying: crt.sh front-end and gateway failures. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Query crt.sh for one watchlist term and return recent certificate sightings.
 *
 * Throws on network/HTTP failure so the caller can record the failure and move
 * on to the next brand rather than aborting the whole run.
 */
export async function fetchRecentCerts(
  term: string,
  options: PollOptions
): Promise<CertQueryResult> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= CRTSH_ATTEMPTS; attempt++) {
    try {
      const rows = await fetchRows(term, options);

      // An empty array is a 200 response, so the error path above never sees it.
      // Retry it once anyway: a broad brand term returning zero certificates
      // ever is not a real answer, and crt.sh recovers on its own often enough
      // that one more attempt is worth the second and a half it costs.
      if (rows.length === 0 && attempt < EMPTY_RESPONSE_ATTEMPTS) {
        await sleep(CRTSH_RETRY_DELAY_MS * attempt);
        continue;
      }

      return { sightings: parseRows(rows, options), rawRowCount: rows.length };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!isRetryable(lastError) || attempt === CRTSH_ATTEMPTS) break;
      await sleep(CRTSH_RETRY_DELAY_MS * attempt);
    }
  }

  if (lastError) {
    throw new Error(
      `crt.sh query for "${term}" failed after ${CRTSH_ATTEMPTS} attempts: ${lastError.message}`
    );
  }

  // Every attempt returned an empty array without erroring.
  return { sightings: [], rawRowCount: 0 };
}

function isRetryable(err: Error): boolean {
  if (err.name === 'AbortError' || err.message.includes('aborted')) return true;
  const status = /HTTP (\d{3})/.exec(err.message)?.[1];
  if (status) return RETRYABLE_STATUS.has(Number(status));
  // Network-level failures (DNS, TLS, connection reset) are worth one more go.
  return !err.message.includes('over the') && !err.message.includes('cap');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRows(term: string, options: PollOptions): Promise<CrtShRow[]> {
  // `%25` is a URL-encoded `%`, which crt.sh treats as a SQL LIKE wildcard.
  // `%term%` therefore matches the term anywhere in any identity on the cert.
  const url = `${CRTSH_ENDPOINT}?q=${encodeURIComponent(`%${term}%`)}&output=json&exclude=expired`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CRTSH_TIMEOUT_MS);
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': SCANNER_USER_AGENT
      },
      cache: 'no-store'
    });

    if (!res.ok) {
      throw new Error(`crt.sh returned HTTP ${res.status} for term "${term}"`);
    }

    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_RESPONSE_BYTES) {
      throw new Error(
        `crt.sh response for "${term}" is ${Math.round(declared / 1e6)}MB, over the ` +
          `${Math.round(MAX_RESPONSE_BYTES / 1e6)}MB cap - the term is too broad to poll.`
      );
    }

    const text = await readCapped(res, MAX_RESPONSE_BYTES);

    // crt.sh serves an HTML error page with a 200 in some failure modes, so a
    // parse failure is treated as a retryable upstream problem, not bad data.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `crt.sh returned HTTP 502-equivalent for "${term}": body was not JSON ` +
          `(starts with "${text.slice(0, 40).replace(/\s+/g, ' ')}")`
      );
    }

    return Array.isArray(parsed) ? (parsed as CrtShRow[]) : [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn raw crt.sh rows into sightings.
 *
 * Exported so it can be tested against recorded fixtures. That matters more than
 * it normally would: crt.sh is unavailable often enough that a test which needs
 * the live service is a test that mostly does not run, and the parsing here has
 * two genuinely subtle behaviours - UTC timestamp handling and SAN splitting -
 * that need coverage either way.
 */
export function parseRows(rows: CrtShRow[], options: PollOptions): CertSighting[] {
  if (!Array.isArray(rows)) return [];

  const cutoff = Date.now() - options.lookbackHours * 3600_000;
  const seen = new Set<string>();
  const sightings: CertSighting[] = [];

  for (const row of rows) {
    const loggedAt = parseCrtShTimestamp(row.entry_timestamp);
    const notBefore = parseCrtShTimestamp(row.not_before);

    // Prefer the CT log entry time; fall back to the certificate's validity
    // start when crt.sh omits it.
    const effective = loggedAt ?? notBefore;
    if (effective && effective.getTime() < cutoff) continue;

    // name_value carries every SAN on the certificate, newline separated.
    const names = new Set<string>();
    if (row.common_name) names.add(row.common_name);
    if (row.name_value) {
      for (const n of row.name_value.split(/\s*\n\s*/)) if (n) names.add(n);
    }

    for (const raw of names) {
      const name = normalizeCertName(raw);
      if (!name) continue;
      // One sighting per domain per poll; the ingest layer dedupes across runs.
      if (seen.has(name)) continue;
      seen.add(name);

      sightings.push({
        name,
        issuer: cleanIssuer(row.issuer_name ?? null),
        notBefore: notBefore ? notBefore.toISOString() : null,
        loggedAt: effective ? effective.toISOString() : null,
        source: 'crt.sh'
      });
    }
  }

  return sightings;
}

/** Read a response body, aborting if it exceeds the cap. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return res.text();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(
          `crt.sh response exceeded the ${Math.round(maxBytes / 1e6)}MB cap.`
        );
      }
      chunks.push(value);
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * crt.sh emits timestamps without a timezone designator, e.g.
 * `2025-09-02T11:22:33.123`. They are UTC. Without the trailing `Z`,
 * `new Date()` parses them in the server's local zone, which silently shifts
 * every "first seen" time by the deployment's offset. Append the Z.
 */
function parseCrtShTimestamp(value: string | undefined): Date | null {
  if (!value) return null;
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Issuer names arrive as full X.500 DNs. Pull out the organisation, which is
 *  what a reader actually wants ("Let's Encrypt", "Google Trust Services"). */
function cleanIssuer(issuer: string | null): string | null {
  if (!issuer) return null;
  const org = /O\s*=\s*"?([^",\/]+)"?/.exec(issuer)?.[1]?.trim();
  const cn = /CN\s*=\s*"?([^",\/]+)"?/.exec(issuer)?.[1]?.trim();
  return org ?? cn ?? issuer.slice(0, 200);
}

/** Politeness delay between crt.sh queries. */
export function crtshDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, CRTSH_DELAY_MS));
}
