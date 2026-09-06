import { RDAP_TIMEOUT_MS, SCANNER_USER_AGENT } from '@/lib/config';
import { boundedTimeout } from '@/lib/util/deadline';
import type { RdapResult } from '@/lib/types';
import { publicSuffix } from '@/lib/util/domain';

/**
 * Verification signal 2: how old is the registration?
 *
 * RDAP (RFC 7483 / 9083) is the structured JSON successor to WHOIS. It is free,
 * needs no key, and is served directly by registries, so there is no rate-limited
 * middleman. IANA publishes a bootstrap file mapping every TLD to its RDAP
 * service, which is how we find the right server without hardcoding one.
 *
 * Age matters because phishing infrastructure is usually consumed within days of
 * registration - the domain is bought, a kit is dropped on it, the lure goes out,
 * and it is burned within a week. But age on its own is close to worthless as an
 * accusation: every legitimate new business also has a domain registered
 * yesterday. It is weighted accordingly in lib/scoring/weights.ts, and is never
 * sufficient to publish on.
 *
 * The `.in` namespace is the awkward one. NIXI's registry RDAP coverage has been
 * inconsistent, and several Indian second-level suffixes return no creation date
 * at all. When RDAP gives us nothing we record that honestly (`rdap_ok = false`)
 * and the scorer simply omits the age signal rather than assuming anything.
 */

/** IANA's RDAP bootstrap. Cached in memory for the life of the process; the
 *  file changes when a TLD's RDAP service moves, which is rare. */
const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';

let bootstrapCache: Map<string, string> | null = null;
let bootstrapFetchedAt = 0;
const BOOTSTRAP_TTL_MS = 24 * 3600_000;

interface RdapEntity {
  roles?: string[];
  vcardArray?: unknown[];
  publicIds?: Array<{ type?: string; identifier?: string }>;
  entities?: RdapEntity[];
}

interface RdapResponse {
  events?: Array<{ eventAction?: string; eventDate?: string }>;
  status?: string[];
  entities?: RdapEntity[];
}

export async function lookupRdap(domain: string, deadlineAt: number): Promise<RdapResult> {
  const empty: RdapResult = {
    ok: false,
    registrar: null,
    createdAt: null,
    ageDays: null,
    statuses: [],
    source: 'none'
  };

  try {
    const budget = boundedTimeout(deadlineAt, RDAP_TIMEOUT_MS);
    if (budget <= 0) return { ...empty, error: 'skipped: job budget exhausted' };

    const base = await rdapServiceFor(domain, deadlineAt);
    if (!base) return { ...empty, error: 'no RDAP service published for this TLD' };

    const url = `${base.replace(/\/$/, '')}/domain/${encodeURIComponent(domain)}`;
    const res = await fetchWithTimeout(url, boundedTimeout(deadlineAt, RDAP_TIMEOUT_MS));

    if (res.status === 404) {
      // The registry says this domain does not exist. That is real information:
      // a certificate for a domain with no registration record usually means the
      // name was dropped after the cert was issued.
      return { ...empty, error: 'not found in registry', source: 'rdap' };
    }
    if (!res.ok) {
      return { ...empty, error: `RDAP HTTP ${res.status}`, source: 'rdap' };
    }

    const body = (await res.json()) as RdapResponse;

    const registrationEvent = body.events?.find(
      (e) => e.eventAction === 'registration' || e.eventAction === 'created'
    );
    const createdRaw = registrationEvent?.eventDate ?? null;
    const created = createdRaw ? new Date(createdRaw) : null;
    const createdValid = created && !Number.isNaN(created.getTime()) ? created : null;

    const ageDays = createdValid
      ? Math.max(0, Math.floor((Date.now() - createdValid.getTime()) / 86400_000))
      : null;

    return {
      ok: true,
      registrar: extractRegistrar(body),
      createdAt: createdValid ? createdValid.toISOString() : null,
      ageDays,
      statuses: body.status ?? [],
      source: 'rdap'
    };
  } catch (err) {
    return {
      ...empty,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/** Find the RDAP base URL for a domain's TLD via the IANA bootstrap file. */
async function rdapServiceFor(domain: string, deadlineAt: number): Promise<string | null> {
  const map = await loadBootstrap(deadlineAt);
  const suffix = publicSuffix(domain);
  const tld = suffix.split('.').pop() ?? '';

  // Try the full suffix first (some registries publish per-SLD services), then
  // fall back to the TLD.
  return map.get(suffix) ?? map.get(tld) ?? null;
}

async function loadBootstrap(deadlineAt: number): Promise<Map<string, string>> {
  const fresh = bootstrapCache && Date.now() - bootstrapFetchedAt < BOOTSTRAP_TTL_MS;
  if (fresh && bootstrapCache) return bootstrapCache;

  try {
    const res = await fetchWithTimeout(BOOTSTRAP_URL, boundedTimeout(deadlineAt, RDAP_TIMEOUT_MS));
    if (!res.ok) throw new Error(`bootstrap HTTP ${res.status}`);
    const body = (await res.json()) as { services?: Array<[string[], string[]]> };

    const map = new Map<string, string>();
    for (const [tlds, urls] of body.services ?? []) {
      // Prefer https endpoints.
      const url = urls.find((u) => u.startsWith('https://')) ?? urls[0];
      if (!url) continue;
      for (const tld of tlds) map.set(tld.toLowerCase(), url);
    }

    bootstrapCache = map;
    bootstrapFetchedAt = Date.now();
    return map;
  } catch {
    // Serve a stale cache rather than failing every lookup because IANA blipped.
    if (bootstrapCache) return bootstrapCache;
    return new Map();
  }
}

/** Registrar name lives in a vCard inside the entity with role "registrar".
 *  The vCard array format is awkward: ["vcard", [["fn", {}, "text", "Name"], ...]] */
function extractRegistrar(body: RdapResponse): string | null {
  const walk = (entities: RdapEntity[] | undefined): string | null => {
    for (const entity of entities ?? []) {
      if (entity.roles?.includes('registrar')) {
        const vcard = entity.vcardArray?.[1];
        if (Array.isArray(vcard)) {
          for (const field of vcard) {
            if (Array.isArray(field) && field[0] === 'fn' && typeof field[3] === 'string') {
              return field[3];
            }
          }
        }
        const ianaId = entity.publicIds?.find((p) => p.type?.includes('IANA'))?.identifier;
        if (ianaId) return `IANA registrar ${ianaId}`;
      }
      const nested = walk(entity.entities);
      if (nested) return nested;
    }
    return null;
  };
  return walk(body.entities);
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  if (timeoutMs <= 0) throw new Error('skipped: job budget exhausted');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/rdap+json, application/json',
        'user-agent': SCANNER_USER_AGENT
      },
      cache: 'no-store'
    });
  } finally {
    clearTimeout(timer);
  }
}
