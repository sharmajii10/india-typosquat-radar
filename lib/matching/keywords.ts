import { PHISHING_KEYWORDS } from '@/lib/config';
import { tokenize } from '@/lib/util/domain';

/**
 * Finding credential-harvesting words in a domain name.
 *
 * Shared by the matcher and the scorer so the two can never disagree about what
 * counts as a keyword - they previously each did their own filtering, which is
 * exactly the kind of duplication that drifts.
 *
 * Matching is token-based rather than substring-based, and that choice matters.
 * A naive substring search for `care` hits `carefree`, `pay` hits `paypal` and
 * `display`, and `otp` hits any number of innocent strings. Since these words
 * are short and common, substring matching would fire on most domains and the
 * signal would carry no information.
 *
 * The one concession is simple English plurals. `reward` is in the list but
 * `paytm-rewards.xyz` tokenizes to `rewards`, and an exact-match-only rule would
 * silently miss it - along with `logins`, `offers`, `alerts` and every other
 * variant nobody remembered to add. Stripping a trailing `s` (and `es` after a
 * sibilant) catches those without widening the match to arbitrary substrings.
 */

const KEYWORD_SET = new Set<string>(PHISHING_KEYWORDS as readonly string[]);

/**
 * Returns the keywords present in a domain or in an already-tokenized label.
 * The returned strings are the canonical list entries, not the raw tokens, so
 * `rewards` is reported as `reward` and the evidence trail stays consistent.
 */
export function findPhishingKeywords(input: string | string[]): string[] {
  const tokens = Array.isArray(input) ? input : tokenize(input);
  const found = new Set<string>();

  for (const token of tokens) {
    const canonical = canonicalKeyword(token);
    if (canonical) found.add(canonical);
  }

  return [...found];
}

function canonicalKeyword(token: string): string | null {
  if (KEYWORD_SET.has(token)) return token;

  // Plural: `rewards` -> `reward`, `logins` -> `login`.
  if (token.endsWith('s')) {
    const singular = token.slice(0, -1);
    if (KEYWORD_SET.has(singular)) return singular;

    // Sibilant plural: `verifies` is not a case we need, but `bonuses` is.
    if (token.endsWith('es')) {
      const stem = token.slice(0, -2);
      if (KEYWORD_SET.has(stem)) return stem;
    }
  }

  return null;
}
