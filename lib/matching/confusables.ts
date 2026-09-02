/**
 * Homoglyph / confusables folding.
 *
 * Source of truth for this mapping is Unicode's published confusables data
 * (UTS #39, `confusables.txt`), which lists characters that render close enough
 * to each other to fool a reader. The full file is ~6,000 entries covering
 * every script pair. Shipping all of it would be dead weight here, because a
 * domain label can only contain characters permitted by IDNA - and the attacks
 * that matter against Indian brands come from a small, well-known set: Cyrillic
 * and Greek letters that look Latin, plus fullwidth and mathematical Latin
 * variants, plus Devanagari digits.
 *
 * So this is a curated subset of confusables.txt restricted to targets in
 * [a-z0-9-]. If you want the complete table, regenerate this file from
 * https://www.unicode.org/Public/security/latest/confusables.txt - the format
 * is `source ; target ; MA` and you want rows whose target is a single ASCII
 * character.
 *
 * Two things come out of folding:
 *   1. A normalised ASCII form to run edit distance against, so that
 *      `sbі.co.in` (Cyrillic i) compares as `sbi.co.in`.
 *   2. The knowledge that folding was *needed*, which is itself a strong
 *      signal. There is no innocent reason for a Cyrillic character in a
 *      domain claiming to be an Indian bank.
 */

import type { HomoglyphDetail } from '@/lib/types';

/** Confusable -> ASCII equivalent. */
export const CONFUSABLES: Record<string, string> = {
  // --- Cyrillic (the classic IDN homograph source) ---
  'а': 'a', 'А': 'a', 'ә': 'a', 'ӓ': 'a',
  'в': 'b', 'В': 'b', 'Ь': 'b', 'ь': 'b', 'Ъ': 'b',
  'с': 'c', 'С': 'c', 'ϲ': 'c', 'ᴄ': 'c',
  'ԁ': 'd', 'Ԁ': 'd',
  'е': 'e', 'Е': 'e', 'ё': 'e', 'Ё': 'e', 'є': 'e', 'Є': 'e', 'э': 'e',
  'ԑ': 'e',
  'ғ': 'f',
  'ԍ': 'g', 'ɡ': 'g',
  'һ': 'h', 'Һ': 'h', 'н': 'h', 'Н': 'h',
  'і': 'i', 'І': 'i', 'ї': 'i', 'Ї': 'i', 'ӏ': 'i', 'Ӏ': 'i', 'ı': 'i',
  'ј': 'j', 'Ј': 'j',
  'к': 'k', 'К': 'k', 'ⱪ': 'k',
  'ⅼ': 'l',
  'м': 'm', 'М': 'm', 'ṁ': 'm',
  'п': 'n', 'И': 'n', 'и': 'n',
  'о': 'o', 'О': 'o', 'ө': 'o', 'Ө': 'o', 'ӧ': 'o', 'ᴏ': 'o',
  'р': 'p', 'Р': 'p',
  'ԛ': 'q', 'Ԛ': 'q',
  'г': 'r', 'Г': 'r', 'ʀ': 'r',
  'ѕ': 's', 'Ѕ': 's',
  'т': 't', 'Т': 't', 'ᴛ': 't',
  'ц': 'u', 'ᴜ': 'u',
  'ѵ': 'v', 'Ѵ': 'v', 'ν': 'v', 'ᴠ': 'v',
  'ԝ': 'w', 'Ԝ': 'w', 'ш': 'w',
  'х': 'x', 'Х': 'x',
  'у': 'y', 'У': 'y', 'ү': 'y', 'Ү': 'y', 'ұ': 'y',
  'ᴢ': 'z',

  // --- Greek ---
  'α': 'a', 'Α': 'a', 'ᾳ': 'a',
  'Β': 'b', 'β': 'b',
  'Ϲ': 'c',
  'Ε': 'e', 'ε': 'e', 'έ': 'e',
  'Η': 'h', 'η': 'n',
  'Ι': 'i', 'ι': 'i', 'ί': 'i',
  'Κ': 'k', 'κ': 'k',
  'Μ': 'm',
  'Ν': 'n',
  'Ο': 'o', 'ο': 'o', 'ό': 'o', 'σ': 'o', 'Θ': 'o', 'θ': 'o',
  'Ρ': 'p', 'ρ': 'p',
  'Τ': 't', 'τ': 't',
  'υ': 'u', 'Υ': 'y', 'ύ': 'u',
  'Χ': 'x', 'χ': 'x',
  'Ζ': 'z',
  'Ω': 'w', 'ω': 'w',
  'γ': 'y',

  // --- Armenian ---
  'ա': 'w', 'օ': 'o', 'ց': 'g', 'ո': 'n', 'պ': 'n', 'ք': 'p',
  'ѐ': 'e', 'հ': 'h', 'ս': 's',

  // --- Latin lookalikes with diacritics / alternate forms ---
  'ạ': 'a', 'ą': 'a', 'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a',
  'å': 'a', 'ā': 'a', 'ă': 'a',
  'ḅ': 'b', 'ḃ': 'b', 'ƅ': 'b', 'ɓ': 'b',
  'ć': 'c', 'ĉ': 'c', 'ċ': 'c', 'č': 'c', 'ç': 'c', 'ḉ': 'c',
  'ď': 'd', 'ḋ': 'd', 'ḍ': 'd', 'đ': 'd', 'ð': 'd',
  'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e', 'ē': 'e', 'ĕ': 'e', 'ė': 'e',
  'ę': 'e', 'ě': 'e', 'ẹ': 'e',
  'ḟ': 'f', 'ƒ': 'f',
  'ĝ': 'g', 'ğ': 'g', 'ġ': 'g', 'ģ': 'g', 'ǥ': 'g',
  'ĥ': 'h', 'ħ': 'h', 'ḥ': 'h', 'ḫ': 'h',
  'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i', 'ĩ': 'i', 'ī': 'i', 'ĭ': 'i',
  'į': 'i', 'ị': 'i',
  'ĵ': 'j', 'ǰ': 'j',
  'ķ': 'k', 'ḳ': 'k', 'ƙ': 'k',
  'ĺ': 'l', 'ļ': 'l', 'ľ': 'l', 'ł': 'l', 'ḷ': 'l', 'ǀ': 'l', 'ⅰ': 'i',
  'ḿ': 'm', 'ṃ': 'm',
  'ń': 'n', 'ņ': 'n', 'ň': 'n', 'ñ': 'n', 'ṅ': 'n', 'ṇ': 'n',
  'ò': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o', 'ø': 'o', 'ō': 'o',
  'ŏ': 'o', 'ő': 'o', 'ọ': 'o', 'ơ': 'o',
  'ṕ': 'p', 'ṗ': 'p', 'ƥ': 'p',
  'ŕ': 'r', 'ŗ': 'r', 'ř': 'r', 'ṙ': 'r', 'ṛ': 'r',
  'ś': 's', 'ŝ': 's', 'ş': 's', 'š': 's', 'ṡ': 's', 'ṣ': 's', 'ſ': 's',
  'ţ': 't', 'ť': 't', 'ŧ': 't', 'ṫ': 't', 'ṭ': 't',
  'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u', 'ũ': 'u', 'ū': 'u', 'ŭ': 'u',
  'ů': 'u', 'ű': 'u', 'ų': 'u', 'ụ': 'u', 'ư': 'u',
  'ṽ': 'v', 'ṿ': 'v',
  'ŵ': 'w', 'ẁ': 'w', 'ẃ': 'w', 'ẅ': 'w', 'ẇ': 'w',
  'ẋ': 'x', 'ẍ': 'x',
  'ý': 'y', 'ŷ': 'y', 'ÿ': 'y', 'ȳ': 'y', 'ỳ': 'y', 'ỵ': 'y',
  'ź': 'z', 'ż': 'z', 'ž': 'z', 'ẓ': 'z',

  // --- Fullwidth Latin (renders identically at small sizes) ---
  'ａ': 'a', 'ｂ': 'b', 'ｃ': 'c', 'ｄ': 'd', 'ｅ': 'e', 'ｆ': 'f', 'ｇ': 'g',
  'ｈ': 'h', 'ｉ': 'i', 'ｊ': 'j', 'ｋ': 'k', 'ｌ': 'l', 'ｍ': 'm', 'ｎ': 'n',
  'ｏ': 'o', 'ｐ': 'p', 'ｑ': 'q', 'ｒ': 'r', 'ｓ': 's', 'ｔ': 't', 'ｕ': 'u',
  'ｖ': 'v', 'ｗ': 'w', 'ｘ': 'x', 'ｙ': 'y', 'ｚ': 'z',
  '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5',
  '６': '6', '７': '7', '８': '8', '９': '9',
  '－': '-', '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-',
  '﹘': '-', '﹣': '-', 'ー': '-',

  // --- Devanagari / Bengali digits, directly relevant to Indian targets ---
  '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5',
  '६': '6', '७': '7', '८': '8', '९': '9',
  '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5',
  '৬': '6', '৭': '7', '৮': '8', '৯': '9',

  // --- Mathematical alphanumerics (bold/italic/monospace Latin) ---
  '𝐚': 'a', '𝐛': 'b', '𝐜': 'c', '𝐝': 'd', '𝐞': 'e', '𝐨': 'o', '𝐢': 'i',
  '𝗮': 'a', '𝗯': 'b', '𝗰': 'c', '𝗱': 'd', '𝗲': 'e', '𝗼': 'o', '𝗶': 'i',
  '𝑎': 'a', '𝑏': 'b', '𝑐': 'c', '𝑑': 'd', '𝑒': 'e', '𝑜': 'o', '𝑖': 'i',
  'ⅾ': 'd', 'ⅿ': 'm', 'ⅽ': 'c', 'ⅹ': 'x',

  // --- Digit/letter swaps that are not Unicode confusables but are the most
  //     common ASCII typosquat trick, folded so they cost 0 edit distance ---
  '0': 'o', '1': 'l', '3': 'e', '5': 's', '4': 'a', '7': 't'
};

/** Codepoints in these ranges are the ones we call out as script-mixing. */
const SCRIPT_RANGES: Array<{ name: string; test: (cp: number) => boolean }> = [
  { name: 'Latin', test: (cp) => (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) },
  { name: 'Digit', test: (cp) => cp >= 0x30 && cp <= 0x39 },
  { name: 'Cyrillic', test: (cp) => cp >= 0x0400 && cp <= 0x04ff },
  { name: 'Greek', test: (cp) => cp >= 0x0370 && cp <= 0x03ff },
  { name: 'Armenian', test: (cp) => cp >= 0x0530 && cp <= 0x058f },
  { name: 'Hebrew', test: (cp) => cp >= 0x0590 && cp <= 0x05ff },
  { name: 'Arabic', test: (cp) => cp >= 0x0600 && cp <= 0x06ff },
  { name: 'Devanagari', test: (cp) => cp >= 0x0900 && cp <= 0x097f },
  { name: 'Bengali', test: (cp) => cp >= 0x0980 && cp <= 0x09ff },
  { name: 'Han', test: (cp) => cp >= 0x4e00 && cp <= 0x9fff },
  { name: 'Fullwidth', test: (cp) => cp >= 0xff00 && cp <= 0xffef }
];

export interface FoldResult {
  /** ASCII-folded form, safe to run edit distance against. */
  folded: string;
  /** True if any character had to be folded from a non-ASCII confusable, or
   *  the label mixed scripts. Digit-for-letter swaps do NOT set this - they are
   *  ordinary ASCII typosquatting, handled by edit distance instead. */
  suspicious: boolean;
  detail: HomoglyphDetail;
}

/**
 * Fold a label to its ASCII skeleton and report what had to be changed.
 *
 * Two normalisation passes run before the lookup table:
 *   - NFKC, which collapses compatibility forms (fullwidth, ligatures) on its
 *     own and handles cases the table misses.
 *   - Combining-mark stripping via NFD, which turns `á` into `a` regardless of
 *     whether the composed form is in the table.
 */
export function foldConfusables(label: string): FoldResult {
  const substitutions: FoldResult['detail']['substitutions'] = [];
  const scripts = new Set<string>();

  // NFKC first: handles fullwidth and compatibility variants generically.
  const nfkc = label.normalize('NFKC');

  let folded = '';
  let sawNonAsciiFold = false;

  for (const char of nfkc) {
    const cp = char.codePointAt(0) ?? 0;
    const script = SCRIPT_RANGES.find((r) => r.test(cp))?.name;
    if (script && script !== 'Digit') scripts.add(script);

    // Strip diacritics: decompose and drop combining marks.
    const stripped = char.normalize('NFD').replace(/[̀-ͯ]/g, '');
    const base = stripped.length > 0 ? stripped : char;

    const mapped = CONFUSABLES[base] ?? CONFUSABLES[char];
    if (mapped) {
      folded += mapped;
      if (mapped !== char) {
        substitutions.push({
          from: char,
          to: mapped,
          codepoint: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0')
        });
        if (cp > 0x7f) sawNonAsciiFold = true;
      }
    } else if (base !== char) {
      // A diacritic was stripped but the base is not in the table (e.g. `ǎ`).
      folded += base.toLowerCase();
      substitutions.push({
        from: char,
        to: base.toLowerCase(),
        codepoint: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0')
      });
      if (cp > 0x7f) sawNonAsciiFold = true;
    } else {
      folded += char.toLowerCase();
      if (cp > 0x7f) sawNonAsciiFold = true;
    }
  }

  // Mixed script is the textbook homograph tell: a single word should not draw
  // from two alphabets. Latin+Digit together is normal and does not count.
  const scriptList = [...scripts];
  const mixedScript = scriptList.length > 1;

  return {
    folded,
    suspicious: sawNonAsciiFold || mixedScript,
    detail: { substitutions, mixedScript, scripts: scriptList }
  };
}

/** True when the string contains any character outside [a-z0-9-]. */
export function hasNonAscii(s: string): boolean {
  return /[^\x00-\x7f]/.test(s);
}
