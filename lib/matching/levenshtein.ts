/**
 * Edit distance, implemented directly rather than pulled from a package.
 *
 * Two reasons: the algorithm is twelve lines and stable since 1965, and the
 * hot loop here runs over every certificate name against every watchlist term,
 * so an early-exit bounded variant is worth more than a generic library.
 */

/**
 * Levenshtein distance with an early exit.
 *
 * `maxDistance` lets the caller say "I only care whether it is within 2".
 * Once every value in a row exceeds the bound, no later row can come back
 * under it, so we bail and return maxDistance + 1. On a watchlist scan this
 * skips the great majority of comparisons after a few columns.
 */
export function levenshtein(a: string, b: string, maxDistance = Infinity): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // A difference in length alone already exceeds the bound.
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  // Keep the shorter string as the row so memory is min(len).
  if (a.length > b.length) [a, b] = [b, a];

  let previous = new Array<number>(a.length + 1);
  let current = new Array<number>(a.length + 1);
  for (let i = 0; i <= a.length; i++) previous[i] = i;

  for (let j = 1; j <= b.length; j++) {
    current[0] = j;
    let rowMin = current[0];

    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[i] = Math.min(
        current[i - 1] + 1, // insertion
        previous[i] + 1, // deletion
        previous[i - 1] + cost // substitution
      );
      if (current[i] < rowMin) rowMin = current[i];
    }

    if (rowMin > maxDistance) return maxDistance + 1;

    [previous, current] = [current, previous];
  }

  return previous[a.length];
}

/**
 * Damerau-Levenshtein: adds transposition as a single edit.
 *
 * This matters more than it looks for typosquatting. `hdfcbnak` is a
 * transposition of `hdfcbank` - one fat-fingered keystroke, and the single most
 * common real typo class. Plain Levenshtein scores it 2 (two substitutions),
 * which would push it to the edge of MAX_EDIT_DISTANCE and rank it alongside
 * genuinely distant names. Scoring it 1 keeps typo-squats where they belong.
 */
export function damerauLevenshtein(a: string, b: string, maxDistance = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;

  for (let i = 1; i <= m; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
      if (d[i][j] < rowMin) rowMin = d[i][j];
    }
    if (rowMin > maxDistance) return maxDistance + 1;
  }

  return d[m][n];
}

/**
 * Normalised similarity in [0,1], where 1 is identical. Used for ranking and
 * for human-readable output; the gating logic uses raw distance so that the
 * threshold means the same thing for short and long terms.
 */
export function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - damerauLevenshtein(a, b) / maxLen;
}
