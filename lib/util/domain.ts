import { MAX_LABEL_LENGTH, STRUCTURAL_IGNORE_SUFFIXES } from '@/lib/config';

/**
 * Minimal public-suffix handling.
 *
 * The full Public Suffix List is ~10k entries and changes weekly. Pulling it in
 * as a dependency would be fine, but this project only needs to be correct for
 * the TLDs Indian brand abuse actually appears under, plus the generic ones
 * cheap registrars push. Anything not on this list falls back to "last label is
 * the suffix", which is right for every single-label TLD.
 *
 * India's namespace is the reason this exists at all: `.co.in`, `.gov.in` and
 * friends are two-label suffixes, so naive last-two-labels logic would treat
 * `sbi.co.in` as the registrable domain `co.in`.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  // India
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in', 'ac.in',
  'edu.in', 'res.in', 'gov.in', 'mil.in', 'nic.in', 'bank.in', 'ernet.in',
  // Commonly abused elsewhere
  'co.uk', 'org.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz',
  'com.br', 'com.cn', 'com.sg', 'com.my', 'com.ph', 'co.id', 'co.za',
  'com.pk', 'com.bd', 'com.np', 'com.lk', 'co.ke', 'com.ng',
  // Free / cheap hosting suffixes seen in phishing
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'web.app',
  'firebaseapp.com', 'netlify.app', 'vercel.app', 'blogspot.com',
  'wixsite.com', 'weebly.com', 'myshopify.com', 'r2.dev', 'onrender.com',
  'glitch.me', 'repl.co', 'surge.sh', 'herokuapp.com', 'azurewebsites.net',
  's3.amazonaws.com', 'duckdns.org', 'ddns.net', 'hopto.org', 'zapto.org',
  'serveo.net', 'ngrok.io', 'ngrok-free.app', 'trycloudflare.com'
]);

/** Lowercase, strip a trailing dot, strip a leading wildcard label. */
export function normalizeCertName(name: string): string {
  let n = name.trim().toLowerCase();
  if (n.startsWith('*.')) n = n.slice(2);
  if (n.endsWith('.')) n = n.slice(0, -1);
  return n;
}

/**
 * Returns the registrable domain (eTLD+1). Returns null for inputs that are
 * not usable domains: IPs, single labels, over-long labels, empty strings.
 */
export function registrableDomain(input: string): string | null {
  const host = normalizeCertName(input);
  if (!host || host.includes(' ') || host.includes('/')) return null;
  // Bare IPv4 / IPv6 are not domains.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  if (host.includes(':')) return null;

  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return null;
  if (labels.some((l) => l.length > MAX_LABEL_LENGTH)) return null;

  const lastTwo = labels.slice(-2).join('.');
  const lastThree = labels.slice(-3).join('.');

  if (labels.length >= 4 && MULTI_LABEL_SUFFIXES.has(lastThree)) {
    return labels.slice(-4).join('.');
  }
  if (labels.length >= 3 && MULTI_LABEL_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

/** The part of the domain before the public suffix - what a squatter chooses.
 *  For `sbi-kyc-update.co.in` this is `sbi-kyc-update`. */
export function registrableLabel(domain: string): string {
  const reg = registrableDomain(domain);
  if (!reg) return '';
  const suffix = publicSuffix(reg);
  return suffix ? reg.slice(0, reg.length - suffix.length - 1) : reg;
}

export function publicSuffix(domain: string): string {
  const labels = domain.split('.');
  const lastTwo = labels.slice(-2).join('.');
  const lastThree = labels.slice(-3).join('.');
  if (labels.length >= 3 && MULTI_LABEL_SUFFIXES.has(lastThree)) return lastThree;
  if (labels.length >= 2 && MULTI_LABEL_SUFFIXES.has(lastTwo)) return lastTwo;
  return labels[labels.length - 1] ?? '';
}

/**
 * True for hosts that legitimately contain brand names because of the platform
 * they sit on - `hdfcbank.zendesk.com` is HDFC's own helpdesk, not a squat.
 * Checked before a candidate is ever written.
 *
 * Note this cuts both ways: `hdfc-bank-login.pages.dev` really can be phishing.
 * Those are still caught, because the check applies to the *registrable* domain
 * only when the brand term sits in the platform-owned part of the name. The
 * matcher runs on the registrable label, so `hdfc-bank-login` under a shared
 * suffix is still evaluated on its own merits.
 */
export function isStructurallyIgnorable(host: string): boolean {
  const h = normalizeCertName(host);
  return STRUCTURAL_IGNORE_SUFFIXES.some(
    (suffix) => h === suffix || h.endsWith(`.${suffix}`)
  );
}

/** Split a label into alphanumeric chunks: `sbi-kyc-update` -> [sbi,kyc,update]. */
export function tokenize(label: string): string[] {
  return label
    .split(/[^a-z0-9]+/i)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/** Punycode label detection - `xn--` prefixed labels are IDN-encoded. */
export function isPunycode(domain: string): boolean {
  return domain.split('.').some((l) => l.startsWith('xn--'));
}

/** Decode punycode to Unicode for display. Returns null if it is not IDN or
 *  cannot be decoded. Uses the platform URL parser rather than a dependency. */
export function toUnicodeDomain(domain: string): string | null {
  if (!isPunycode(domain)) return null;
  try {
    // The URL parser round-trips through IDNA; `hostname` gives punycode back,
    // so decode label-by-label with the built-in punycode algorithm instead.
    return domain
      .split('.')
      .map((label) => (label.startsWith('xn--') ? punycodeDecode(label.slice(4)) : label))
      .join('.');
  } catch {
    return null;
  }
}

/** RFC 3492 punycode decoder. Small enough to inline; avoids a dependency on
 *  the deprecated Node `punycode` module. */
function punycodeDecode(input: string): string {
  const base = 36;
  const tMin = 1;
  const tMax = 26;
  const skew = 38;
  const damp = 700;
  const initialBias = 72;
  const initialN = 128;
  const delimiter = '-';

  const output: number[] = [];
  let n = initialN;
  let i = 0;
  let bias = initialBias;

  const lastDelim = input.lastIndexOf(delimiter);
  if (lastDelim > 0) {
    for (let j = 0; j < lastDelim; j++) output.push(input.charCodeAt(j));
  }

  const adapt = (delta: number, numPoints: number, firstTime: boolean): number => {
    let d = firstTime ? Math.floor(delta / damp) : delta >> 1;
    d += Math.floor(d / numPoints);
    let k = 0;
    while (d > ((base - tMin) * tMax) >> 1) {
      d = Math.floor(d / (base - tMin));
      k += base;
    }
    return k + Math.floor(((base - tMin + 1) * d) / (d + skew));
  };

  for (let idx = lastDelim > 0 ? lastDelim + 1 : 0; idx < input.length; ) {
    const oldi = i;
    let w = 1;
    for (let k = base; ; k += base) {
      if (idx >= input.length) throw new Error('bad punycode');
      const code = input.charCodeAt(idx++);
      let digit: number;
      if (code >= 0x30 && code <= 0x39) digit = code - 0x30 + 26;
      else if (code >= 0x61 && code <= 0x7a) digit = code - 0x61;
      else if (code >= 0x41 && code <= 0x5a) digit = code - 0x41;
      else throw new Error('bad punycode');
      i += digit * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      w *= base - t;
    }
    const outLen = output.length + 1;
    bias = adapt(i - oldi, outLen, oldi === 0);
    n += Math.floor(i / outLen);
    i %= outLen;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}
