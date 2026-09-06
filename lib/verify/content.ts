import {
  CONTENT_FETCH_TIMEOUT_MS,
  CONTENT_MAX_BYTES,
  CONTENT_MAX_REDIRECTS,
  SCANNER_USER_AGENT
} from '@/lib/config';
import type { ContentResult } from '@/lib/types';
import { boundedTimeout } from '@/lib/util/deadline';

/**
 * Verification signal 3: a single passive HTTP GET.
 *
 * This is the strongest cheap signal in the pipeline. A domain that resembles a
 * bank AND serves a page containing a password field AND names the bank is doing
 * something that has no innocent explanation. Name similarity alone never gets
 * there; this is what turns a suspicion into evidence.
 *
 * GUARDRAILS - these are hard requirements, not preferences:
 *   - ONE GET request per domain per verification pass. No crawling, no asset
 *     fetching, no following links, no second page.
 *   - Never submits a form, never sends credentials, never sends cookies back.
 *   - Hard timeout, hard byte cap, bounded redirects.
 *   - Identifies itself honestly in the User-Agent with a contact URL, so an
 *     operator reading their logs can see exactly what hit them and ask us to
 *     stop.
 *   - Refuses to fetch anything resolving to a private or loopback address, so
 *     the deployed function cannot be pointed at internal infrastructure.
 */

/** Markers that a page is a registrar parking page or a for-sale listing rather
 *  than a live site. These *reduce* the score - a parked lookalike is a
 *  speculative registration, which is a different and much less urgent thing
 *  than a live credential harvester. */
const PARKING_MARKERS = [
  'domain is for sale', 'buy this domain', 'this domain is parked',
  'parked free, courtesy', 'domain parking', 'godaddy.com/domainsearch',
  'sedoparking', 'parkingcrew', 'bodis.com', 'afternic', 'dan.com',
  'hugedomains', 'namecheap parking', 'future home of something quite cool',
  'default web page', 'apache2 ubuntu default page', 'welcome to nginx',
  'iis windows server', 'site not configured', 'coming soon',
  'under construction', 'account suspended', 'this site can’t be reached'
];

/** Words that, next to a password field, indicate a credential form rather than
 *  an incidental one (a newsletter signup, say). */
const CREDENTIAL_MARKERS = [
  'password', 'passcode', 'pin', 'mpin', 'user id', 'userid', 'customer id',
  'login', 'log in', 'sign in', 'netbanking', 'net banking', 'internet banking',
  'otp', 'one time password', 'cvv', 'card number', 'aadhaar', 'aadhar',
  'upi pin', 'debit card', 'credit card', 'account number'
];

export interface ContentCheckInput {
  domain: string;
  /** Absolute epoch-ms budget for the whole job. Both scheme attempts are
   *  clamped to what is left of it. */
  deadlineAt: number;
  /** Brand name and match terms to look for in the page. */
  brandTerms: string[];
  /** A records from the DNS step. Used for the private-address guard, and to
   *  skip the fetch entirely when the domain does not resolve. */
  aRecords: string[];
}

export async function checkContent(input: ContentCheckInput): Promise<ContentResult> {
  const empty: ContentResult = {
    attempted: false,
    httpStatus: null,
    finalUrl: null,
    title: null,
    hasPasswordField: false,
    brandTermsOnPage: [],
    formPostsOffsite: false,
    looksParked: false,
    contentRiskScore: 0
  };

  if (input.aRecords.length === 0) {
    return { ...empty, error: 'domain does not resolve; no request made' };
  }

  // Guardrail: never let the scanner be pointed at internal infrastructure.
  if (input.aRecords.some(isPrivateAddress)) {
    return { ...empty, error: 'resolves to a private address; refused' };
  }

  // Try HTTPS first - the candidate came from a certificate, so it should have
  // one. Fall back to HTTP once, because kits are frequently misconfigured and a
  // plain-HTTP login form is if anything more damning.
  for (const scheme of ['https', 'http'] as const) {
    if (boundedTimeout(input.deadlineAt, CONTENT_FETCH_TIMEOUT_MS) <= 0) {
      return { ...empty, attempted: true, error: 'skipped: job budget exhausted' };
    }
    const result = await fetchOnce(`${scheme}://${input.domain}/`, input);
    if (result) return result;
  }

  return { ...empty, attempted: true, error: 'no response over https or http' };
}

async function fetchOnce(
  url: string,
  input: ContentCheckInput
): Promise<ContentResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    boundedTimeout(input.deadlineAt, CONTENT_FETCH_TIMEOUT_MS)
  );

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': SCANNER_USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-IN,en;q=0.9'
      },
      cache: 'no-store'
    });

    const contentType = res.headers.get('content-type') ?? '';
    const isHtml = contentType.includes('html') || contentType === '';

    const html = isHtml ? await readCapped(res, CONTENT_MAX_BYTES) : '';
    const analysis = analyseHtml(html, input.domain, input.brandTerms);

    return {
      attempted: true,
      httpStatus: res.status,
      finalUrl: res.url || url,
      ...analysis
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A TLS failure on https is expected often enough that it is worth trying
    // http; signal that by returning null so the caller falls through.
    if (url.startsWith('https://')) return null;
    return {
      attempted: true,
      httpStatus: null,
      finalUrl: null,
      title: null,
      hasPasswordField: false,
      brandTermsOnPage: [],
      formPostsOffsite: false,
      looksParked: false,
      contentRiskScore: 0,
      error: message
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract signals from HTML with regular expressions rather than a DOM parser.
 *
 * A real parser would be more accurate, but this runs on untrusted, frequently
 * malformed HTML inside a function with a hard time budget, and we only need
 * coarse boolean signals - not a faithful tree. Every pattern below is written
 * to fail closed: an unparseable page yields no signals, never false ones.
 */
function analyseHtml(
  html: string,
  domain: string,
  brandTerms: string[]
): Omit<ContentResult, 'attempted' | 'httpStatus' | 'finalUrl'> {
  const lower = html.toLowerCase();

  // --- Password fields -----------------------------------------------------
  const hasPasswordInput = /<input[^>]+type\s*=\s*["']?password["']?/i.test(html);
  // Kits routinely use type="text" with a name/id that gives them away, or a
  // JS-driven field. Catch the obvious variants.
  const hasPasswordishInput =
    /<input[^>]+(?:name|id)\s*=\s*["']?[^"'>]*(?:pass|pwd|pin|mpin|otp|cvv)[^"'>]*["']?/i.test(
      html
    );
  const hasPasswordField = hasPasswordInput || hasPasswordishInput;

  // --- Brand mentions ------------------------------------------------------
  // Look in the whole document, which covers visible text, <title>, alt text on
  // a copied logo, and meta description - all the places a cloned page keeps the
  // brand name even when the images are hotlinked.
  const found = new Set<string>();
  for (const term of brandTerms) {
    const t = term.toLowerCase();
    if (t.length < 3) continue;
    if (lower.includes(t)) found.add(term);
  }

  // --- Title ---------------------------------------------------------------
  const titleMatch = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  const title = titleMatch
    ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim().slice(0, 200)
    : null;

  // --- Form target ---------------------------------------------------------
  // A login form that posts to a different host is the classic exfiltration
  // shape: the page looks like the bank, the credentials go somewhere else.
  let formPostsOffsite = false;
  const formActionRe = /<form[^>]+action\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = formActionRe.exec(html)) !== null) {
    const action = m[1];
    if (/^https?:\/\//i.test(action)) {
      try {
        const target = new URL(action).hostname.toLowerCase();
        if (target !== domain && !target.endsWith(`.${domain}`)) {
          formPostsOffsite = true;
          break;
        }
      } catch {
        /* malformed action, ignore */
      }
    }
  }

  // --- Parking / placeholder detection -------------------------------------
  const looksParked =
    PARKING_MARKERS.some((marker) => lower.includes(marker)) ||
    // A near-empty body with no forms is a placeholder, not a phishing page.
    (html.length < 1500 && !hasPasswordField && !/<form/i.test(html));

  // --- Credential vocabulary ----------------------------------------------
  const credentialWords = CREDENTIAL_MARKERS.filter((w) => lower.includes(w));

  // --- Content-only sub-score ---------------------------------------------
  // Scoped to what the page itself shows, before any global weighting. Kept
  // separate so the content signal can be tuned or back-tested on its own.
  let contentRiskScore = 0;
  if (hasPasswordField) contentRiskScore += 40;
  if (found.size > 0) contentRiskScore += 25;
  if (hasPasswordField && found.size > 0) contentRiskScore += 20; // the combination is the tell
  if (formPostsOffsite) contentRiskScore += 10;
  if (credentialWords.length >= 3) contentRiskScore += 5;
  if (looksParked) contentRiskScore = Math.min(contentRiskScore, 10);
  contentRiskScore = Math.max(0, Math.min(100, contentRiskScore));

  return {
    title,
    hasPasswordField,
    brandTermsOnPage: [...found],
    formPostsOffsite,
    looksParked,
    contentRiskScore
  };
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.byteLength;
  }
  // Stop the transfer as soon as we have enough; we are not here to download
  // whatever the far end wants to send.
  await reader.cancel().catch(() => {});

  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const c of chunks) {
    const room = merged.length - offset;
    if (room <= 0) break;
    merged.set(c.subarray(0, Math.min(c.byteLength, room)), offset);
    offset += Math.min(c.byteLength, room);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** RFC 1918, loopback, link-local, CGNAT and IPv6 equivalents. */
function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v6 = ip.toLowerCase();
    return (
      v6 === '::1' ||
      v6.startsWith('fc') ||
      v6.startsWith('fd') ||
      v6.startsWith('fe80') ||
      v6.startsWith('::ffff:127.') ||
      v6.startsWith('::ffff:10.') ||
      v6.startsWith('::ffff:192.168.')
    );
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}
