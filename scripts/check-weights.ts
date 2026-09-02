/**
 * Asserts the safety invariant behind this project's core principle.
 *
 *   npm run check:weights
 *
 * The principle is that domain-name similarity alone must never be enough to
 * publish a public accusation. That is currently true because of arithmetic:
 * the name category's weights add up to less than the high-confidence
 * threshold. Arithmetic is easy to break by accident while tuning, so it is
 * checked mechanically rather than left as a comment nobody re-reads.
 *
 * Run it in CI alongside the type check. If it fails, either lower the name
 * weights or raise TIER_THRESHOLD_HIGH - do not delete the check.
 *
 * Imports are relative rather than aliased so this runs under plain `tsx`
 * without depending on tsconfig path resolution.
 */

import {
  HIGH_TIER_MIN_EVIDENCE_CATEGORIES,
  HIGH_TIER_REQUIRED_STRONG_SIGNALS,
  TIER_THRESHOLD_HIGH,
  TIER_THRESHOLD_MEDIUM
} from '../lib/config';
import {
  CATEGORY_CEILINGS,
  CERTIFICATE_WEIGHTS,
  CONTENT_WEIGHTS,
  INFRASTRUCTURE_WEIGHTS,
  NAME_WEIGHTS,
  REGISTRATION_WEIGHTS
} from '../lib/scoring/weights';

let failures = 0;

function check(description: string, condition: boolean, detail: string) {
  if (condition) {
    console.log(`  PASS  ${description}`);
  } else {
    console.error(`  FAIL  ${description}`);
    console.error(`        ${detail}`);
    failures++;
  }
}

console.log('\nScoring invariants\n');

// --- The core principle, as arithmetic -------------------------------------
const nameCeiling = CATEGORY_CEILINGS.name;
check(
  'Name similarity alone cannot reach high confidence',
  nameCeiling < TIER_THRESHOLD_HIGH,
  `Name weights can total ${nameCeiling}, and the high threshold is ${TIER_THRESHOLD_HIGH}. ` +
    `A domain could be published on its name alone. Lower the name weights or raise the threshold.`
);

// --- Name alone should not even reach the review queue ---------------------
// Weaker claim, and only a warning rather than a failure: putting a pure name
// match in front of a human is defensible, publishing it is not.
if (nameCeiling >= TIER_THRESHOLD_MEDIUM) {
  console.log(
    `  WARN  Name weights can total ${nameCeiling}, at or above the medium threshold ` +
      `(${TIER_THRESHOLD_MEDIUM}). A pure name match can reach the human review queue. ` +
      `That is allowed, but it will make the queue noisy.`
  );
}

// --- Publication must require more than one kind of evidence ---------------
check(
  'High confidence requires more than one evidence category',
  HIGH_TIER_MIN_EVIDENCE_CATEGORIES >= 2,
  `HIGH_TIER_MIN_EVIDENCE_CATEGORIES is ${HIGH_TIER_MIN_EVIDENCE_CATEGORIES}. ` +
    `One category means a single kind of observation can publish a domain.`
);

check(
  'At least one signal with no innocent reading is required to publish',
  HIGH_TIER_REQUIRED_STRONG_SIGNALS.length > 0,
  'HIGH_TIER_REQUIRED_STRONG_SIGNALS is empty, so the strong-signal gate does nothing.'
);

// --- Thresholds must be ordered --------------------------------------------
check(
  'Tier thresholds are ordered',
  TIER_THRESHOLD_MEDIUM < TIER_THRESHOLD_HIGH,
  `Medium (${TIER_THRESHOLD_MEDIUM}) must be below high (${TIER_THRESHOLD_HIGH}).`
);

// --- Registration age must not dominate ------------------------------------
check(
  'Being newly registered cannot outweigh what the page actually serves',
  REGISTRATION_WEIGHTS.ageUnder3Days < CONTENT_WEIGHTS.passwordField,
  `Newest-registration weight is ${REGISTRATION_WEIGHTS.ageUnder3Days} and the password-field ` +
    `weight is ${CONTENT_WEIGHTS.passwordField}. Age has an enormous innocent base rate and ` +
    `must stay below direct evidence of a credential form.`
);

// --- The mitigating weight must be able to cancel a full name match --------
check(
  'An established domain can have its name match fully cancelled',
  Math.abs(REGISTRATION_WEIGHTS.ageOver1Year) >= NAME_WEIGHTS.exactToken,
  `ageOver1Year is ${REGISTRATION_WEIGHTS.ageOver1Year} against an exactToken weight of ` +
    `${NAME_WEIGHTS.exactToken}. A years-old unrelated business would keep net positive points ` +
    `purely for its name.`
);

// --- Certificate timing must stay a corroborator ---------------------------
check(
  'Certificate timing stays a corroborating signal, not a finding',
  CERTIFICATE_WEIGHTS.certSameDayAsRegistration < INFRASTRUCTURE_WEIGHTS.resolves,
  `Same-day certificate issuance (${CERTIFICATE_WEIGHTS.certSameDayAsRegistration}) is weighted ` +
    `at or above resolution (${INFRASTRUCTURE_WEIGHTS.resolves}). Automatic TLS provisioning ` +
    `produces this pattern for legitimate sites constantly.`
);

// --- A realistic worst case for a legitimate business ----------------------
// hdfc-consulting.com: exact token match, resolves, has mail, registered years
// ago, serves an ordinary site with no password field.
const legitimateBusiness =
  NAME_WEIGHTS.exactToken +
  INFRASTRUCTURE_WEIGHTS.resolves +
  INFRASTRUCTURE_WEIGHTS.hasMx +
  REGISTRATION_WEIGHTS.ageOver1Year;

check(
  'An established unrelated business with a matching name scores below review',
  legitimateBusiness < TIER_THRESHOLD_MEDIUM,
  `A years-old business whose name contains a brand term, with a working site and mail, ` +
    `scores ${legitimateBusiness} against a medium threshold of ${TIER_THRESHOLD_MEDIUM}. ` +
    `It would be shown publicly as "under review".`
);

// --- A realistic true positive must still publish --------------------------
// A new lookalike that resolves and serves a branded login page.
const obviousPhish =
  NAME_WEIGHTS.exactToken +
  NAME_WEIGHTS.phishingKeyword +
  INFRASTRUCTURE_WEIGHTS.resolves +
  REGISTRATION_WEIGHTS.ageUnder3Days +
  CONTENT_WEIGHTS.passwordField +
  CONTENT_WEIGHTS.brandOnPage +
  CONTENT_WEIGHTS.passwordAndBrand;

check(
  'A live branded credential-harvest page still reaches high confidence',
  obviousPhish >= TIER_THRESHOLD_HIGH,
  `A new domain containing the brand name and a phishing keyword, live, serving a branded ` +
    `login form, scores only ${obviousPhish} against a high threshold of ${TIER_THRESHOLD_HIGH}. ` +
    `The gates are now so tight that nothing will ever publish.`
);

console.log('');
if (failures > 0) {
  console.error(`${failures} invariant${failures === 1 ? '' : 's'} violated.\n`);
  process.exit(1);
}
console.log('All scoring invariants hold.\n');
