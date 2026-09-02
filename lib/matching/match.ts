import { MAX_EDIT_DISTANCE, MIN_TERM_LENGTH_FOR_FUZZY } from '@/lib/config';
import { foldConfusables } from '@/lib/matching/confusables';
import { findPhishingKeywords } from '@/lib/matching/keywords';
import { damerauLevenshtein } from '@/lib/matching/levenshtein';
import type { Brand, MatchKind, MatchResult } from '@/lib/types';
import {
  isStructurallyIgnorable,
  registrableDomain,
  registrableLabel,
  toUnicodeDomain,
  tokenize
} from '@/lib/util/domain';

/**
 * The candidate matcher.
 *
 * This layer answers one narrow question: "does this certificate name look like
 * it is reaching for a watchlisted brand?" It deliberately does NOT decide
 * whether the domain is malicious. Name similarity is a weak signal on its own -
 * `hdfc-consulting.com` will match here, and should, because the pipeline's job
 * is to then go and check whether it resolves, how old it is, and whether it
 * serves a login form. The scorer and the confidence gate are what stop a name
 * match from becoming a public accusation.
 *
 * Being permissive here and strict later is the right split: a false negative at
 * this stage is invisible and unrecoverable, whereas a false positive is caught
 * downstream at no cost beyond one DNS query.
 */

/** A minimal substring match on a short term produces garbage - `upi` is inside
 *  `occupied`, `sbi` is inside plenty of Hindi transliterations. Substring
 *  matching is therefore restricted to terms at least this long; shorter terms
 *  must match a whole token. */
const MIN_TERM_LENGTH_FOR_SUBSTRING = 5;

/** Ranked worst-to-best so a stronger match kind always wins for a domain. */
const MATCH_KIND_RANK: Record<MatchKind, number> = {
  substring: 1,
  keyword_combo: 2,
  edit_distance: 3,
  homoglyph: 4,
  exact_token: 5
};

export interface MatcherInput {
  /** Domain as seen in the certificate. Wildcards are fine. */
  name: string;
  brands: Brand[];
  /** Lowercased registrable domains that must never produce a candidate. */
  allowlist: Set<string>;
}

/**
 * Returns the single best match for a certificate name, or null.
 *
 * Only one match is returned even when a name resembles several brands. A
 * domain gets one row and one attribution; ambiguous cases pick the strongest
 * match kind, then the smallest edit distance, then the longest matched term
 * (longer terms are more specific and less likely to be coincidence).
 */
export function matchCertName(input: MatcherInput): MatchResult | null {
  const domain = registrableDomain(input.name);
  if (!domain) return null;

  // --- Guardrail: the allowlist runs before anything else. ------------------
  // A brand's own domains and any human-cleared domain are excluded here, at
  // the top of the pipeline, so they can never reach scoring regardless of what
  // they look like.
  if (input.allowlist.has(domain)) return null;

  // Shared platform hosts legitimately carry brand names in their subdomains.
  if (isStructurallyIgnorable(domain)) return null;

  const asciiLabel = registrableLabel(domain);
  if (!asciiLabel) return null;

  // Certificate Transparency records IDN domains in their punycode form, so a
  // homograph attack arrives here looking like `xn--pytm-loa` - pure ASCII, with
  // the substituted character encoded away. Folding that string finds nothing,
  // because there is nothing left to find.
  //
  // Decoding first is what makes homoglyph detection work at all: `xn--pytm-loa`
  // becomes `päytm`, which folds to `paytm` and matches exactly, and the fold
  // reports that a non-ASCII character had to be normalised away. Without this
  // step the single strongest name signal in the model would never once fire in
  // production.
  const label = toUnicodeDomain(asciiLabel) ?? asciiLabel;

  const fold = foldConfusables(label);
  const foldedLabel = fold.folded;
  const tokens = tokenize(foldedLabel);
  // A hyphen-free label like `hdfcbanklogin` tokenizes as one blob, so also
  // compare against the whole label with separators removed.
  const flat = foldedLabel.replace(/[^a-z0-9]/g, '');

  let best: MatchResult | null = null;

  for (const brand of input.brands) {
    if (!brand.active) continue;

    // Second allowlist pass: never flag a brand's own domains, even if the
    // allowlist table has not been seeded yet.
    if (brand.official_domains.some((d) => d.toLowerCase() === domain)) continue;

    for (const rawTerm of brand.match_terms) {
      const term = rawTerm.toLowerCase().trim();
      if (!term) continue;

      const candidate = evaluateTerm({ brand, term, domain, flat, tokens, fold });

      if (candidate && isBetter(candidate, best)) best = candidate;
    }
  }

  return best;
}

interface EvalArgs {
  brand: Brand;
  term: string;
  domain: string;
  /** Folded label with separators removed - `hdfc-bank` becomes `hdfcbank`. */
  flat: string;
  /** Folded label split on separators. */
  tokens: string[];
  fold: ReturnType<typeof foldConfusables>;
}

function evaluateTerm(args: EvalArgs): MatchResult | null {
  const { brand, term, domain, flat, tokens, fold } = args;

  const keywords = findPhishingKeywords(tokens);

  let kind: MatchKind | null = null;
  let distance = 0;
  let why = '';

  // --- 1. Exact token. `sbi-secure.com` -> token `sbi` is the brand term. ----
  if (tokens.includes(term)) {
    kind = 'exact_token';
    distance = 0;
    why = `The name contains "${term}" as a complete word.`;
  }
  // --- 2. Whole label equals the term under folding. ------------------------
  else if (flat === term) {
    kind = 'exact_token';
    distance = 0;
    why = `The name is exactly "${term}" under a different top-level domain.`;
  }
  // --- 3. Substring, long terms only. `myhdfcbanknet.com`. ------------------
  else if (term.length >= MIN_TERM_LENGTH_FOR_SUBSTRING && flat.includes(term)) {
    kind = 'substring';
    distance = 0;
    why = `The name contains "${term}" inside a longer word.`;
  }
  // --- 4. Fuzzy, long terms only. -------------------------------------------
  else if (term.length >= MIN_TERM_LENGTH_FOR_FUZZY) {
    // Compare the term against each token and against the whole flattened
    // label. The whole-label comparison catches `hdfcbannk.com`; the per-token
    // comparison catches `hdfcbannk-secure.com`, where the noise word would
    // otherwise blow the distance past the threshold.
    let bestDistance = MAX_EDIT_DISTANCE + 1;
    let matchedAgainst = '';

    for (const probe of [flat, ...tokens]) {
      // Skip probes whose length is too far off to possibly be within bound.
      if (Math.abs(probe.length - term.length) > MAX_EDIT_DISTANCE) continue;
      const d = damerauLevenshtein(probe, term, MAX_EDIT_DISTANCE);
      if (d < bestDistance) {
        bestDistance = d;
        matchedAgainst = probe;
      }
    }

    if (bestDistance <= MAX_EDIT_DISTANCE && bestDistance > 0) {
      kind = 'edit_distance';
      distance = bestDistance;
      why =
        `"${matchedAgainst}" is ${bestDistance} character ` +
        `${bestDistance === 1 ? 'change' : 'changes'} away from "${term}".`;
    }
  }

  if (!kind) return null;

  // --- Upgrade the match kind on stronger evidence. -------------------------
  // Homoglyph beats a plain name match: folding was *required* to see the
  // resemblance, which means someone chose a non-Latin character on purpose.
  if (fold.suspicious && fold.detail.substitutions.some((s) => s.from.codePointAt(0)! > 0x7f)) {
    kind = 'homoglyph';
    const subs = fold.detail.substitutions
      .filter((s) => s.from.codePointAt(0)! > 0x7f)
      .map((s) => `${s.from} (${s.codepoint}) posing as "${s.to}"`)
      .join(', ');
    why += ` The name uses look-alike characters: ${subs}.`;
  }
  // A brand term plus a credential-harvesting word is a stronger statement of
  // intent than either alone, so it outranks a bare substring hit.
  else if (keywords.length > 0 && MATCH_KIND_RANK[kind] < MATCH_KIND_RANK.keyword_combo) {
    kind = 'keyword_combo';
    why += ` It is combined with "${keywords.join('", "')}".`;
  }

  return {
    domain,
    unicodeDomain: toUnicodeDomain(domain),
    brandId: brand.id,
    brandSlug: brand.slug,
    matchedTerm: term,
    matchKind: kind,
    editDistance: distance,
    homoglyphFlag: fold.suspicious,
    homoglyphDetail: fold.suspicious ? fold.detail : null,
    keywords,
    explanation: why.trim()
  };
}

function isBetter(a: MatchResult, b: MatchResult | null): boolean {
  if (!b) return true;
  const rankA = MATCH_KIND_RANK[a.matchKind];
  const rankB = MATCH_KIND_RANK[b.matchKind];
  if (rankA !== rankB) return rankA > rankB;
  if (a.editDistance !== b.editDistance) return a.editDistance < b.editDistance;
  // Longer terms are more specific, so less likely to be coincidence.
  return a.matchedTerm.length > b.matchedTerm.length;
}

/**
 * Re-exported from `lib/matching/terms.ts`, which has no imports of its own so
 * the seed script can use it without pulling in the whole pipeline.
 */
export { deriveMatchTerms } from '@/lib/matching/terms';
