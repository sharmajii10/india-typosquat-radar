/**
 * ===========================================================================
 * RISK SCORING WEIGHTS - the single place every number in the score comes from.
 * ===========================================================================
 *
 * How to read this file
 * --------------------
 * Each weight is a point contribution toward a 0-100 score. Every weight below
 * carries a comment explaining why it is the size it is, because these are
 * starting estimates from how phishing infrastructure is known to behave, NOT
 * values fitted to data. They will be wrong in detail. The comments exist so
 * that whoever tunes them later knows what the original reasoning was and can
 * tell a deliberate choice from an accident.
 *
 * How to tune them properly, once the pipeline has been running
 * ------------------------------------------------------------
 * PhishTank and OpenPhish publish confirmed-phishing feeds, and the Tranco list
 * gives a clean negative set. Run both through the scorer with the pipeline's
 * real verification output, then move thresholds to whatever gives an acceptable
 * false-positive rate. For a tool that makes public accusations, precision
 * matters far more than recall: a missed phishing site is a site we were never
 * going to be the only ones to catch, whereas a wrongly published legitimate
 * business is a real harm to a real person.
 *
 * The invariant that must survive any retuning
 * --------------------------------------------
 * NAME-SHAPE SIGNALS ALONE MUST NOT REACH TIER_THRESHOLD_HIGH.
 * The name category maxes out at 44 (homoglyph 28 + keywords 10 + mixed script 6)
 * against a HIGH threshold of 70, and in fact stays below the MEDIUM threshold
 * of 45 as well. If you raise these, check the arithmetic
 * again - `npm run check:weights` asserts it, and that assertion is the
 * mechanical form of this project's core principle.
 */

import type { EvidenceCategory } from '@/lib/types';

export const WEIGHTS_VERSION = 'v1';

// ---------------------------------------------------------------------------
// CATEGORY: name. How the domain is spelled.
//
// Ceiling: 44. This is the weak, noisy signal the whole project is built around
// not trusting. It is enough to make something worth checking and never enough
// to make it worth publishing.
// ---------------------------------------------------------------------------
export const NAME_WEIGHTS = {
  /**
   * 28. The strongest name signal by a wide margin, and the only one in this
   * category that is genuinely self-evidencing.
   *
   * Using a Cyrillic "а" or a fullwidth "ｅ" inside a domain that otherwise
   * spells an Indian bank has no legitimate explanation. Nobody registers that
   * by accident, and no real business wants a name its customers cannot type.
   * Every other signal in this file describes something that thousands of
   * legitimate sites also do; this one does not.
   *
   * It was originally set at 20, only two points above an exact token match,
   * which badly understated the difference between them. `hdfc-consulting.com`
   * and `hdfcbа nk.com` (Cyrillic а) are not remotely the same kind of evidence.
   * At 28, a look-alike domain registered in the last few days reaches the human
   * review queue on its own, before it has been pointed at a server - which is
   * the early warning this project exists to give.
   *
   * Note what it still cannot do: 28 + 10 + 6 = 44, so even the maximum possible
   * name score stays below the review threshold of 45 and far below the
   * publication threshold of 70. The margin above medium is one point, which is
   * deliberate and tight. Raising any name weight further will cross it, so
   * `npm run check:weights` warns when it does.
   */
  homoglyphNonAscii: 28,

  /**
   * 18. `hdfcbank.xyz`, or `sbi` as a standalone word in `sbi-rewards.com`.
   * High, because a squatter reproducing the brand token exactly is the most
   * common pattern by volume. Not higher, because this is also what a genuine
   * unrelated entity looks like: `hdfc-consulting.com` scores here, and the
   * whole point of the pipeline is that this number alone decides nothing.
   */
  exactToken: 18,

  /**
   * 12 / 8 by distance. One edit (`hdfcbnak`, `icicibnak`) is a deliberate
   * typo-squat aimed at fat fingers, and is worth nearly as much as an exact
   * match. Two edits is materially weaker: at that distance real unrelated words
   * start colliding, especially for longer terms, so it is discounted by a third.
   */
  editDistance1: 12,
  editDistance2: 8,

  /**
   * 8. The brand term appears inside a longer word (`myhdfcbanknet`). Weak on
   * its own - substring collisions are common and often innocent - but it is
   * real evidence when it stacks with anything else.
   */
  substring: 8,

  /**
   * 10. A credential-harvesting word sits next to the brand term: `kyc`,
   * `netbanking`, `verify`, `otp`, `login`. This is a statement of intent about
   * what the domain is FOR, which is different in kind from what it is NAMED,
   * and that is why it is weighted just below a one-character typo-squat rather
   * than treated as a rounding error.
   *
   * It matters most for domains that have not gone live yet. A name like
   * `hdfcbank-login.com` registered yesterday with no DNS record has no
   * infrastructure or content evidence to draw on, and this project's stated
   * purpose is to surface those *before* they are weaponised. At 10 rather than
   * 8, a brand token plus a credential keyword plus a fresh registration is
   * enough to reach the human review queue, which is where such a domain
   * belongs - visible, labelled unconfirmed, and re-checked until it either
   * goes live or is dismissed.
   *
   * Not higher, because legitimate bank and vendor domains genuinely do contain
   * `netbanking`, `support` and `payment`. This has to nudge, not decide - and
   * the arithmetic still keeps the whole name category below the publication
   * threshold.
   */
  phishingKeyword: 10,

  /**
   * 6. The label draws characters from more than one script. Distinct from the
   * homoglyph weight above: a label can mix scripts without any single character
   * being individually confusable, and that mixture is itself the textbook IDN
   * homograph construction. Small, because legitimate multilingual domains do
   * exist - it should nudge, not decide.
   */
  mixedScript: 6
} as const;

// ---------------------------------------------------------------------------
// CATEGORY: infrastructure. Whether the domain is actually live.
//
// Ceiling: 26.
// ---------------------------------------------------------------------------
export const INFRASTRUCTURE_WEIGHTS = {
  /**
   * 20. The single highest-value cheap check in the pipeline. A large share of
   * registered lookalikes never get pointed at anything, and a domain with no A
   * record is not currently harming anyone - there is nothing for a visitor to
   * be tricked by. Weighted heavily because it is the difference between a
   * speculative registration and live infrastructure, and it gates publication
   * outright (see HIGH_TIER_REQUIRES_RESOLUTION).
   */
  resolves: 20,

  /**
   * 6. Mail exchangers configured on a lookalike domain mean someone intends to
   * send or receive mail as that brand - the lure half of the attack, or
   * business email compromise. Genuine additional signal, but small: MX records
   * come free with most hosting bundles and are frequently just default config.
   */
  hasMx: 6
} as const;

// ---------------------------------------------------------------------------
// CATEGORY: registration. How new the domain is.
//
// Ceiling: 14. Mitigating floor: -18.
// ---------------------------------------------------------------------------
export const REGISTRATION_WEIGHTS = {
  /**
   * 14 / 12 / 8 / 4 on a decaying scale. Phishing domains are typically used
   * within days of registration - bought, loaded with a kit, burned. So very new
   * is genuinely suspicious.
   *
   * But the scale is deliberately shallow at the top and decays fast, because
   * this signal has an enormous innocent base rate: every legitimate business
   * registering its first domain today lands in the same bucket. It is a
   * multiplier on other suspicion, never a finding on its own. Capped at 14 so
   * that even "registered four hours ago" cannot push a name-only match past
   * the medium threshold by itself.
   */
  ageUnder3Days: 14,
  ageUnder7Days: 12,
  ageUnder30Days: 8,
  ageUnder90Days: 4,

  /**
   * -18. THE MOST IMPORTANT NEGATIVE WEIGHT IN THE FILE.
   *
   * This is the `hdfcconsulting.com` case from the project's founding principle,
   * expressed numerically. A domain that has existed for over a year and matches
   * a brand name is overwhelmingly likely to be a real, unrelated business that
   * got there first, a defensive registration nobody added to the allowlist, or
   * a long-dormant squat that never became an attack. Phishing infrastructure
   * does not sit unused for a year.
   *
   * Sized to be able to cancel an entire name-category match on its own
   * (-18 against exactToken's +18), because that is exactly the collision it
   * exists to neutralise.
   */
  ageOver1Year: -18
} as const;

// ---------------------------------------------------------------------------
// CATEGORY: content. What the page actually serves.
//
// Ceiling: 52. The strongest evidence available at MVP cost.
// ---------------------------------------------------------------------------
export const CONTENT_WEIGHTS = {
  /**
   * 22. A password input on a domain that resembles a bank. This is the point
   * where a suspicion becomes evidence of harm: there is now a place for a
   * victim to type a credential. The largest single weight in the file, and the
   * one most likely to be the reason something publishes.
   */
  passwordField: 22,

  /**
   * 12. The brand's name appears in the page - title, body, or the alt text of
   * a copied logo. Alone this is weak, because a page can mention a bank for a
   * hundred innocent reasons (a comparison site, a news article, a complaint).
   */
  brandOnPage: 12,

  /**
   * 12. Combination bonus for password field AND brand mention together. This
   * is deliberately scored as a separate signal rather than folded into the
   * other two, because the conjunction is much more than the sum: a page that
   * both impersonates a brand and asks for a password is a credential harvester
   * with essentially no innocent reading. Splitting it out also makes the
   * evidence panel honest - a reader can see that it was the combination, not
   * either fact alone, that drove the score.
   */
  passwordAndBrand: 12,

  /**
   * 6. A form on the page posts to a different host. Classic exfiltration shape:
   * the page looks like the bank, the credentials travel elsewhere. Modest
   * because legitimate sites do this constantly - third-party auth, analytics,
   * embedded payment providers.
   */
  formPostsOffsite: 6,

  /**
   * -15. The page is a registrar parking page, a for-sale listing, a default
   * server page, or effectively empty. A parked lookalike is a speculative
   * registration, not a live attack. It should stay on the internal list and
   * keep getting rechecked - parked today is not parked forever - but it must
   * not be published as though someone were being phished right now.
   */
  looksParked: -15
} as const;

// ---------------------------------------------------------------------------
// CATEGORY: certificate. How the cert was obtained.
//
// Ceiling: 12.
// ---------------------------------------------------------------------------
export const CERTIFICATE_WEIGHTS = {
  /**
   * 8. A certificate issued the same day the domain was registered. This is the
   * automated-phishing-kit fingerprint: register, point DNS, pull a free DV cert,
   * deploy, all inside one script run.
   *
   * Kept well below the content weights on purpose. The exact same pattern is
   * produced by every modern hosting platform that provisions TLS automatically -
   * which is to say, by almost every legitimate new site too. It is a
   * corroborating detail, never a finding.
   */
  certSameDayAsRegistration: 8,
  /** 4. Within three days. Same reasoning, weaker. */
  certWithin3Days: 4,

  /**
   * 4. Issued by a free, fully-automated DV certificate authority.
   *
   * Very small, and it should stay very small. Free DV authorities issue the
   * clear majority of certificates on the web, including for most legitimate
   * small sites, and treating "used a free CA" as suspicious would penalise
   * exactly the small Indian businesses this project must not harm. It is here
   * only because it is a weak corroborator of the automated-kit pattern above.
   */
  freeDvIssuer: 4
} as const;

// ---------------------------------------------------------------------------
// CATEGORY: hosting. Not scored at MVP - see lib/verify/asn.ts for why.
// ---------------------------------------------------------------------------
export const HOSTING_WEIGHTS = {
  /** 0 until a free, redistributable ASN reputation source is wired in.
   *  Present so the wiring point is obvious, not because it does anything. */
  knownAbusedAsn: 0
} as const;

/** Free / automated DV issuers, matched case-insensitively against the cert's
 *  issuer organisation. Used only by CERTIFICATE_WEIGHTS.freeDvIssuer. */
export const FREE_DV_ISSUERS = [
  "let's encrypt",
  'zerossl',
  'google trust services',
  'buypass',
  'actalis',
  'ssl.com',
  'cloudflare inc ecc ca'
] as const;

/** Category ceilings, kept alongside the weights so the invariant above can be
 *  asserted mechanically rather than trusted. */
export const CATEGORY_CEILINGS: Record<EvidenceCategory, number> = {
  name:
    NAME_WEIGHTS.homoglyphNonAscii +
    NAME_WEIGHTS.phishingKeyword +
    NAME_WEIGHTS.mixedScript,
  infrastructure: INFRASTRUCTURE_WEIGHTS.resolves + INFRASTRUCTURE_WEIGHTS.hasMx,
  registration: REGISTRATION_WEIGHTS.ageUnder3Days,
  content:
    CONTENT_WEIGHTS.passwordField +
    CONTENT_WEIGHTS.brandOnPage +
    CONTENT_WEIGHTS.passwordAndBrand +
    CONTENT_WEIGHTS.formPostsOffsite,
  certificate:
    CERTIFICATE_WEIGHTS.certSameDayAsRegistration + CERTIFICATE_WEIGHTS.freeDvIssuer,
  hosting: HOSTING_WEIGHTS.knownAbusedAsn,
  mitigating: 0
};
