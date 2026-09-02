/**
 * Match-term derivation.
 *
 * Kept in its own module with no imports so the seed script can pull it in
 * without dragging the whole pipeline (and its path aliases) along with it.
 */

/** Public suffixes needed to find the registrable label of a seed domain.
 *  A trimmed copy of the list in lib/util/domain.ts - only the suffixes that
 *  actually appear in brand seed data need to be here. */
const SEED_SUFFIXES = new Set([
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in', 'ac.in',
  'edu.in', 'res.in', 'gov.in', 'mil.in', 'nic.in', 'bank.in',
  'co.uk', 'com.au', 'co.za'
]);

/**
 * Derive the terms the matcher searches for, from a brand's name, official
 * domains and aliases.
 *
 * Terms shorter than three characters are dropped outright: at that length
 * every string is close to every other string, and the result is pure noise.
 */
export function deriveMatchTerms(
  name: string,
  officialDomains: string[],
  aliases: string[]
): string[] {
  const terms = new Set<string>();

  const add = (raw: string) => {
    const t = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (t.length >= 3) terms.add(t);
  };

  // "HDFC Bank" -> "hdfcbank"
  add(name);

  // "hdfcbank.com" -> "hdfcbank"; "sbi.co.in" -> "sbi"
  for (const domain of officialDomains) {
    const label = registrableLabelForSeed(domain.toLowerCase());
    if (label) add(label);
  }

  for (const alias of aliases) add(alias);

  return [...terms].sort((a, b) => b.length - a.length);
}

function registrableLabelForSeed(domain: string): string {
  const labels = domain.replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return '';

  const lastTwo = labels.slice(-2).join('.');
  const lastThree = labels.slice(-3).join('.');

  let suffixLabelCount = 1;
  if (labels.length >= 3 && SEED_SUFFIXES.has(lastThree)) suffixLabelCount = 3;
  else if (labels.length >= 2 && SEED_SUFFIXES.has(lastTwo)) suffixLabelCount = 2;

  const registrableIndex = labels.length - suffixLabelCount - 1;
  return registrableIndex >= 0 ? labels[registrableIndex] : '';
}
