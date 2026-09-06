import { MIN_TERM_LENGTH_FOR_FUZZY } from '@/lib/config';
import { foldConfusables } from '@/lib/matching/confusables';
import { toUnicodeDomain } from '@/lib/util/domain';

/**
 * The scanner's pre-filter.
 *
 * CT logs carry millions of certificates a day. Posting every name back to the
 * radar for proper matching is not viable, so names are filtered where they are
 * read and the rest are discarded before they cost anything.
 *
 * THE CONTRACT: this must be a permissive SUPERSET of what
 * `lib/matching/match.ts` accepts. Anything the real matcher would flag has to
 * get through, because whatever this drops is never seen again by anything. The
 * reverse is fine - passing through names the matcher then rejects costs one
 * HTTP round trip. Being wrong permissively is cheap; being wrong strictly is a
 * silent, permanent miss.
 *
 * Within that constraint it should still be tight, and the first version was
 * not. Measured against live logs it passed 0.72% of entries, which at real
 * volumes is tens of thousands of pointless posts a day. Two things caused it,
 * and both were places where this filter was looser than the matcher rather
 * than merely simpler:
 *
 *   1. Short terms were matched as substrings. `sbi` is three characters, so it
 *      appears inside ordinary words - `joshnesbitt.co.uk` was being posted.
 *      The matcher only accepts short terms as whole tokens, and now so does
 *      this.
 *
 *   2. Every punycode name passed unconditionally, on the reasoning that a
 *      homoglyph is invisible until decoded. True, but the fix is to decode it
 *      here rather than to wave it through: `xn--` names are a large share of
 *      CT traffic and almost none of them target Indian banks.
 */

export interface InterestFilter {
  (name: string): boolean;
}

/** Mirrors MIN_TERM_LENGTH_FOR_SUBSTRING in lib/matching/match.ts. Shorter
 *  terms must match a whole label, exactly as the matcher requires. */
const MIN_TERM_LENGTH_FOR_SUBSTRING = 5;

export function buildInterestFilter(terms: string[]): InterestFilter {
  const usable = terms
    .map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length >= 3);

  if (usable.length === 0) return () => false;

  // Long enough to be found inside a bigger word.
  const substringTerms = usable.filter((t) => t.length >= MIN_TERM_LENGTH_FOR_SUBSTRING);
  const substringRe =
    substringTerms.length > 0 ? new RegExp(substringTerms.map(escapeRegex).join('|')) : null;

  // Short terms: whole-label matches only.
  const exactTerms = new Set(usable.filter((t) => t.length < MIN_TERM_LENGTH_FOR_SUBSTRING));

  // Deletion index for edit-distance-1 detection. Two strings are within one
  // edit exactly when their "delete one character" variant sets intersect (the
  // SymSpell idea). Precomputing the term side turns the per-name check into a
  // few set lookups instead of a Levenshtein pass over every term, which would
  // be far too slow at this volume.
  const deletionIndex = new Set<string>();
  for (const term of usable) {
    if (term.length < MIN_TERM_LENGTH_FOR_FUZZY) continue;
    deletionIndex.add(term);
    for (const variant of deletions(term)) deletionIndex.add(variant);
  }

  /** The checks, run against one already-normalised form of a name. */
  function looksInteresting(lower: string): boolean {
    const flat = lower.replace(/[^a-z0-9]/g, '');
    if (flat.length < 3) return false;

    if (substringRe && substringRe.test(flat)) return true;

    // Whole-label equality for short terms: `sbi-verify.com` passes,
    // `joshnesbitt.co.uk` does not.
    if (exactTerms.size > 0) {
      for (const label of lower.split(/[^a-z0-9]+/)) {
        if (exactTerms.has(label)) return true;
      }
      if (exactTerms.has(flat)) return true;
    }

    if (deletionIndex.size === 0) return false;

    // Single-character typo-squats: hdfcbamk.com, icicibnak.com. Checked on the
    // whole flattened name and on each label, because a typo in one label of
    // `hdfcbamk-secure.com` leaves the full string too far from the term.
    if (matchesWithinOneEdit(flat, deletionIndex)) return true;
    for (const label of lower.split(/[^a-z0-9]+/)) {
      if (label.length < MIN_TERM_LENGTH_FOR_FUZZY - 1) continue;
      if (matchesWithinOneEdit(label, deletionIndex)) return true;
    }

    return false;
  }

  return function isInteresting(name: string): boolean {
    const lower = name.toLowerCase();

    if (looksInteresting(lower)) return true;

    // Internationalised names need decoding before they can be judged, exactly
    // as the matcher does it. `xn--pytm-loa.com` is meaningless as ASCII and
    // becomes `paytm` once decoded and folded.
    if (lower.includes('xn--')) {
      const unicode = toUnicodeDomain(lower);
      if (!unicode) {
        // Undecodable punycode. Pass it through rather than guess - the
        // matcher gets the final say, and the contract is to be permissive.
        return true;
      }
      const folded = unicode
        .split('.')
        .map((label) => foldConfusables(label).folded)
        .join('.');
      return looksInteresting(folded);
    }

    return false;
  };
}

function matchesWithinOneEdit(candidate: string, index: Set<string>): boolean {
  if (index.has(candidate)) return true;
  for (const variant of deletions(candidate)) {
    if (index.has(variant)) return true;
  }
  return false;
}

/** Every string formed by deleting exactly one character. */
function deletions(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    out.push(s.slice(0, i) + s.slice(i + 1));
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
