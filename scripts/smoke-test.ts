/**
 * End-to-end smoke test for the matcher, scorer and confidence gates.
 *
 *   npm run smoke
 *
 * No database and no network. It feeds synthetic certificate names and
 * synthetic verification results through the real pipeline code and asserts the
 * outcome, which makes it the fastest way to see whether a change to the
 * weights or the matcher broke something that matters.
 *
 * The cases are chosen to cover the two failures this project actually cares
 * about, in order of severity:
 *
 *   1. Publishing a legitimate business. Cases marked LEGITIMATE must never
 *      reach 'high', and mostly should not reach 'medium' either.
 *   2. Missing a live credential harvester. Cases marked PHISHING must reach
 *      'high' when the evidence is there.
 *
 * Run with `--verbose` to see every signal that fired for each case.
 */

import { parseRows, type CrtShRow } from '../lib/ct/crtsh';
import { matchCertName } from '../lib/matching/match';
import { scoreCandidate } from '../lib/scoring/score';
import { publishStateForTier } from '../lib/scoring/score';
import type { Brand, Tier, VerificationBundle } from '../lib/types';

const verbose = process.argv.includes('--verbose');

// --- A miniature watchlist, shaped exactly like the seeded one -------------
const BRANDS: Brand[] = [
  brand('HDFC Bank', 'hdfc-bank', ['hdfcbank.com'], ['hdfcbank', 'hdfc']),
  brand('State Bank of India', 'sbi', ['sbi.co.in', 'onlinesbi.sbi'], [
    'statebankofindia',
    'onlinesbi',
    'sbi'
  ]),
  brand('Paytm', 'paytm', ['paytm.com'], ['paytm']),
  brand('UIDAI / Aadhaar', 'uidai-aadhaar', ['uidai.gov.in'], ['uidai', 'aadhaar'])
];

const ALLOWLIST = new Set(['hdfcbank.com', 'sbi.co.in', 'paytm.com', 'hdfclife.com']);

// --- Verification fixtures --------------------------------------------------
function bundle(overrides: DeepPartial<VerificationBundle> = {}): VerificationBundle {
  return {
    dns: {
      resolves: false,
      aRecords: [],
      hasMx: false,
      nsRecords: [],
      ...(overrides.dns ?? {})
    },
    rdap: {
      ok: true,
      registrar: 'Example Registrar',
      createdAt: null,
      ageDays: null,
      statuses: [],
      source: 'rdap',
      ...(overrides.rdap ?? {})
    },
    content: {
      attempted: false,
      httpStatus: null,
      finalUrl: null,
      title: null,
      hasPasswordField: false,
      brandTermsOnPage: [],
      formPostsOffsite: false,
      looksParked: false,
      contentRiskScore: 0,
      ...(overrides.content ?? {})
    },
    asn: { ip: null, asn: null, asnOrg: null, reputationScore: null, ...(overrides.asn ?? {}) }
  } as VerificationBundle;
}

/** A live credential-harvesting page on a brand-new domain. */
const LIVE_PHISH = bundle({
  dns: { resolves: true, aRecords: ['203.0.113.10'], hasMx: true, nsRecords: ['ns1.example.'] },
  rdap: { ageDays: 1, createdAt: daysAgo(1) },
  content: {
    attempted: true,
    httpStatus: 200,
    hasPasswordField: true,
    brandTermsOnPage: ['hdfcbank'],
    formPostsOffsite: true,
    contentRiskScore: 95
  }
});

/** Registered, but never pointed anywhere. The common case by volume. */
const DORMANT = bundle({ rdap: { ageDays: 2, createdAt: daysAgo(2) } });

/** A registrar parking page. */
const PARKED = bundle({
  dns: { resolves: true, aRecords: ['198.51.100.5'] },
  rdap: { ageDays: 5, createdAt: daysAgo(5) },
  content: { attempted: true, httpStatus: 200, looksParked: true }
});

/** An established, ordinary business site. No password field. */
const ESTABLISHED_BUSINESS = bundle({
  dns: { resolves: true, aRecords: ['198.51.100.20'], hasMx: true },
  rdap: { ageDays: 2200, createdAt: daysAgo(2200) },
  content: { attempted: true, httpStatus: 200, title: 'HDFC Consulting Services' }
});

/** A young but genuine startup with a customer login. The hardest case in the
 *  whole model: new, live, has a password field, mentions a payment brand
 *  because it integrates with one. */
const YOUNG_LEGITIMATE_WITH_LOGIN = bundle({
  dns: { resolves: true, aRecords: ['198.51.100.30'], hasMx: true },
  rdap: { ageDays: 40, createdAt: daysAgo(40) },
  content: {
    attempted: true,
    httpStatus: 200,
    hasPasswordField: true,
    brandTermsOnPage: [],
    title: 'Merchant Dashboard',
    contentRiskScore: 40
  }
});

// --- Cases -----------------------------------------------------------------
interface Case {
  /** Certificate name to feed the matcher. */
  name: string;
  /** Optional display name, when two cases share a domain. */
  as?: string;
  label: 'PHISHING' | 'LEGITIMATE' | 'NOISE';
  verification: VerificationBundle;
  certIssuer?: string;
  /** Expected outcome. `null` means the matcher should reject it outright. */
  expect: Tier | 'no-match';
  why: string;
}

const CASES: Case[] = [
  // --- Must never match at all ---------------------------------------------
  {
    name: 'hdfcbank.com',
    label: 'LEGITIMATE',
    verification: LIVE_PHISH,
    expect: 'no-match',
    why: 'The brand\'s own domain is allowlisted, so nothing downstream ever sees it.'
  },
  {
    name: 'hdfclife.com',
    label: 'LEGITIMATE',
    verification: ESTABLISHED_BUSINESS,
    expect: 'no-match',
    why: 'A subsidiary on the seeded allowlist.'
  },
  {
    name: 'hdfcbank.zendesk.com',
    label: 'LEGITIMATE',
    verification: LIVE_PHISH,
    expect: 'no-match',
    why: 'A shared platform host - the bank\'s own helpdesk, not a squat.'
  },
  {
    name: 'occupied.com',
    label: 'NOISE',
    verification: LIVE_PHISH,
    expect: 'no-match',
    why: 'Contains "upi" as a substring. Short terms match whole words only.'
  },
  {
    name: 'sbicapital-markets.example',
    label: 'NOISE',
    verification: DORMANT,
    expect: 'no-match',
    why: '"sbicapital" is not the token "sbi", and is too far for fuzzy matching.'
  },

  // --- Must never be published ---------------------------------------------
  {
    name: 'hdfc-consulting.com',
    label: 'LEGITIMATE',
    verification: ESTABLISHED_BUSINESS,
    expect: 'low',
    why: 'The founding example. An exact token match, live and with mail, but years old - the age mitigation cancels the name signal.'
  },
  {
    name: 'hdfcbank-login.com',
    label: 'PHISHING',
    verification: DORMANT,
    expect: 'medium',
    why: 'Obvious intent in the name, but it does not resolve, so nobody can be reaching it. Held for review, never published.'
  },
  {
    name: 'paytm-rewards.xyz',
    label: 'PHISHING',
    verification: PARKED,
    expect: 'medium',
    why: 'Parked rather than live. Suspicious, but not currently harming anyone.'
  },
  {
    name: 'newfintech-portal.com',
    label: 'LEGITIMATE',
    verification: YOUNG_LEGITIMATE_WITH_LOGIN,
    expect: 'no-match',
    why: 'No brand term at all, so it never becomes a candidate however new or login-shaped it is.'
  },

  // --- Homoglyph / IDN cases ----------------------------------------------
  // These arrive from Certificate Transparency in punycode. If the matcher ever
  // stops decoding before folding, they silently become no-match and the
  // strongest name signal in the model goes dark without anything failing
  // loudly. That is exactly the kind of regression a test has to catch.
  {
    name: 'xn--pytm-loa.com',
    as: 'xn--pytm-loa (dormant)',
    label: 'PHISHING',
    verification: DORMANT,
    expect: 'medium',
    why: 'Punycode for "pÃ¤ytm". Look-alike characters with no innocent reading, but not yet live, so it is held for review rather than published.'
  },
  {
    name: 'xn--pytm-loa.com',
    as: 'xn--pytm-loa (live)',
    label: 'PHISHING',
    verification: {
      ...LIVE_PHISH,
      content: { ...LIVE_PHISH.content, brandTermsOnPage: ['paytm'] }
    },
    expect: 'high',
    why: 'The same look-alike domain, now live and serving a branded credential form.'
  },

  // --- Must be published ---------------------------------------------------
  {
    name: 'hdfcbank-secure-login.com',
    label: 'PHISHING',
    verification: LIVE_PHISH,
    certIssuer: "Let's Encrypt",
    expect: 'high',
    why: 'Live, brand new, serves a branded login form. The case the whole tool exists for.'
  },
  {
    name: 'onlinesbi-kyc-update.in',
    label: 'PHISHING',
    verification: {
      ...LIVE_PHISH,
      content: { ...LIVE_PHISH.content, brandTermsOnPage: ['onlinesbi', 'sbi'] }
    },
    certIssuer: "Let's Encrypt",
    expect: 'high',
    why: 'Brand token plus a KYC lure, live with a credential form.'
  },
  {
    name: 'hdfcbamk.com',
    label: 'PHISHING',
    verification: {
      ...LIVE_PHISH,
      content: { ...LIVE_PHISH.content, brandTermsOnPage: ['hdfcbank'] }
    },
    expect: 'high',
    why: 'A one-character typo-squat, live, serving a branded login page.'
  }
];

// --- Runner ----------------------------------------------------------------
let failures = 0;

console.log('\nPipeline smoke test\n');
console.log(
  '  ' +
    'domain'.padEnd(30) +
    'label'.padEnd(12) +
    'expected'.padEnd(11) +
    'actual'.padEnd(11) +
    'score'
);
console.log('  ' + '-'.repeat(74));

for (const testCase of CASES) {
  const match = matchCertName({
    name: testCase.name,
    brands: BRANDS,
    allowlist: ALLOWLIST
  });

  let actual: string;
  let score = 0;
  let signalLines: string[] = [];

  if (!match) {
    actual = 'no-match';
  } else {
    const result = scoreCandidate({
      candidate: {
        domain: match.domain,
        match_kind: match.matchKind,
        edit_distance: match.editDistance,
        homoglyph_flag: match.homoglyphFlag,
        homoglyph_detail: match.homoglyphDetail,
        matched_term: match.matchedTerm,
        cert_issuer: testCase.certIssuer ?? null,
        cert_issued_at: daysAgo(0)
      },
      verification: testCase.verification,
      brandName: BRANDS.find((b) => b.id === match.brandId)?.name ?? 'unknown'
    });
    actual = result.tier;
    score = result.score;
    signalLines = result.signals.map(
      (s) => `        ${String(s.points).padStart(4)}  ${s.label}`
    );
    if (result.gateNote) signalLines.push(`        gate: ${result.gateNote}`);
    signalLines.push(
      `        -> publish_state: ${publishStateForTier(result.tier, 'hidden')}`
    );
  }

  const ok = actual === testCase.expect;
  if (!ok) failures++;

  console.log(
    `  ${ok ? ' ' : '!'} ` +
      (testCase.as ?? testCase.name).padEnd(30) +
      testCase.label.padEnd(12) +
      testCase.expect.padEnd(11) +
      actual.padEnd(11) +
      (match ? String(score) : '-')
  );

  if (!ok) {
    console.log(`      EXPECTED ${testCase.expect}, GOT ${actual}`);
    console.log(`      Rationale: ${testCase.why}`);
  }
  if (verbose || !ok) {
    for (const line of signalLines) console.log(line);
    console.log('');
  }
}

console.log('');

// ===========================================================================
// crt.sh row parsing, against a recorded fixture.
//
// crt.sh is unavailable often enough that a test needing the live service is a
// test that mostly does not run. These rows reproduce its real response shape,
// and they cover the behaviours that are easy to get quietly wrong.
// ===========================================================================
console.log('crt.sh parsing\n');

const NOW = Date.now();

/**
 * crt.sh emits timestamps with no timezone designator, e.g.
 * `2025-09-02T11:22:33.123`. They are UTC. The fixture reproduces that exactly,
 * because appending the missing "Z" is what one of the checks below verifies.
 */
const hoursAgo = (h: number) =>
  new Date(NOW - h * 3600_000).toISOString().replace('Z', '');

const LE_ISSUER = "C=US, O=Let's Encrypt, CN=R11";
const GTS_ISSUER = 'C=US, O=Google Trust Services LLC, CN=WE1';

const FIXTURE: CrtShRow[] = [
  {
    issuer_name: LE_ISSUER,
    common_name: 'hdfcbank-secure.com',
    // One certificate carrying several subject alternative names, newline
    // separated, including a wildcard. All three must come out as separate
    // sightings, with the wildcard prefix stripped.
    name_value: ['hdfcbank-secure.com', '*.hdfcbank-secure.com', 'www.hdfcbank-secure.com'].join(
      '\n'
    ),
    entry_timestamp: hoursAgo(2),
    not_before: hoursAgo(3)
  },
  {
    issuer_name: GTS_ISSUER,
    common_name: 'paytm-verify.in',
    name_value: 'paytm-verify.in',
    entry_timestamp: hoursAgo(5),
    not_before: hoursAgo(5)
  },
  {
    // Outside the lookback window - must be dropped.
    issuer_name: LE_ISSUER,
    common_name: 'old-hdfcbank-thing.com',
    name_value: 'old-hdfcbank-thing.com',
    entry_timestamp: hoursAgo(200),
    not_before: hoursAgo(200)
  },
  {
    // A name already seen on an earlier certificate - must be collapsed to one.
    issuer_name: LE_ISSUER,
    common_name: 'hdfcbank-secure.com',
    name_value: 'hdfcbank-secure.com',
    entry_timestamp: hoursAgo(1),
    not_before: hoursAgo(1)
  }
];

// parseRows never makes a network call, so the deadline is irrelevant here;
// it is a required field of PollOptions, so give it a far-future value.
const parsed = parseRows(FIXTURE, { lookbackHours: 24, deadlineAt: Date.now() + 60_000 });
const parsedNames = parsed.map((p) => p.name).sort();
const issuers = [...new Set(parsed.map((p) => p.issuer))];

parseCheck(
  'Splits every subject alternative name into its own sighting',
  parsedNames.includes('www.hdfcbank-secure.com'),
  `got: ${parsedNames.join(', ')}`
);

parseCheck(
  'Strips the wildcard prefix instead of emitting "*.example.com"',
  !parsedNames.some((n) => n.startsWith('*.')) && parsedNames.includes('hdfcbank-secure.com'),
  `got: ${parsedNames.join(', ')}`
);

parseCheck(
  'Drops certificates logged outside the lookback window',
  !parsedNames.includes('old-hdfcbank-thing.com'),
  `got: ${parsedNames.join(', ')}`
);

parseCheck(
  'Collapses a repeated name to a single sighting',
  parsedNames.filter((n) => n === 'hdfcbank-secure.com').length === 1,
  `got: ${parsedNames.join(', ')}`
);

parseCheck(
  'Reads the issuer organisation out of the X.500 distinguished name',
  issuers.includes("Let's Encrypt") && issuers.includes('Google Trust Services LLC'),
  `got issuers: ${issuers.join(' | ')}`
);

parseCheck(
  'Treats crt.sh timestamps as UTC rather than server-local time',
  // Without the appended "Z", a machine east of Greenwich parses these as local
  // time and shifts every "first seen" value - in India, by five and a half
  // hours, which is enough to place a brand new certificate in the future.
  // Five hours ago must stay roughly five hours ago in every timezone.
  (() => {
    const sighting = parsed.find((p) => p.name === 'paytm-verify.in');
    if (!sighting?.loggedAt) return false;
    const deltaHours = (NOW - Date.parse(sighting.loggedAt)) / 3600_000;
    return deltaHours > 4.5 && deltaHours < 5.5;
  })(),
  `loggedAt=${parsed.find((p) => p.name === 'paytm-verify.in')?.loggedAt}, now=${new Date(NOW).toISOString()}`
);

console.log('');

function parseCheck(description: string, condition: boolean, detail: string) {
  if (condition) {
    console.log(`    PASS  ${description}`);
  } else {
    console.error(`    FAIL  ${description}`);
    console.error(`          ${detail}`);
    failures++;
  }
}

// --- The safety assertion that matters most --------------------------------
const publishedLegitimate = CASES.filter(
  (c) => c.label === 'LEGITIMATE' && c.expect === 'high'
);
if (publishedLegitimate.length > 0) {
  console.error(
    'A case labelled LEGITIMATE expects to be published. That is never acceptable.\n'
  );
  failures++;
}

if (failures > 0) {
  console.error(`${failures} check${failures === 1 ? '' : 's'} failed.\n`);
  process.exit(1);
}
console.log(`All ${CASES.length} pipeline cases and every parsing check passed.\n`);

// --- helpers ---------------------------------------------------------------
function brand(
  name: string,
  slug: string,
  officialDomains: string[],
  matchTerms: string[]
): Brand {
  return {
    id: slug,
    name,
    slug,
    category: 'bank',
    official_domains: officialDomains,
    aliases: [],
    match_terms: matchTerms,
    active: true,
    last_polled_at: null,
    created_at: new Date().toISOString()
  };
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400_000).toISOString();
}

type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> };
