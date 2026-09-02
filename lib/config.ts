/**
 * Central configuration. Every tunable threshold in the pipeline lives here or
 * in `lib/scoring/weights.ts` - nowhere else. If you find a bare number in a
 * matcher, verifier or route handler, it is a bug.
 */

// ---------------------------------------------------------------------------
// Confidence gating.
//
// These three constants decide what the public ever sees, so they are the most
// consequential numbers in the codebase.
//
//   score >= HIGH   -> auto-published, stated as a detection
//   score >= MEDIUM -> queued for human review, shown only as "unconfirmed"
//   below that      -> logged internally, never shown publicly
//
// Starting values are deliberately conservative. Under `lib/scoring/weights.ts`
// a domain cannot reach 70 on name similarity alone: name-shape signals cap out
// at 44, so HIGH always requires live-infrastructure or content evidence on
// top. They stay just below MEDIUM too, so a pure name match is not even shown
// as unconfirmed. That relationship is the safety property - if you raise the name-shape
// weights, re-check it (there is a guard test in scripts/check-weights.ts).
// ---------------------------------------------------------------------------
export const TIER_THRESHOLD_HIGH = 70;
export const TIER_THRESHOLD_MEDIUM = 45;

/**
 * Hard gate on top of the numeric threshold. Even a domain scoring 100 is held
 * at `medium` unless it produced at least this many *independent* evidence
 * categories (name / infrastructure / registration / content / certificate).
 *
 * Rationale: the brief's core principle. A single very strong signal is not
 * enough to make a public accusation - `hdfcconsulting.com` could score high on
 * name shape and nothing else. Two independent categories means two different
 * things about the domain had to look wrong.
 */
export const HIGH_TIER_MIN_EVIDENCE_CATEGORIES = 2;

/**
 * A domain can never be auto-published unless it actually resolves. If it does
 * not exist on the internet yet, there is nothing to warn anyone about, and the
 * cost of being wrong is all downside.
 */
export const HIGH_TIER_REQUIRES_RESOLUTION = true;

/**
 * The last gate, and the strictest. Auto-publication additionally requires at
 * least one signal from this set - a corroborating pile of weak evidence is not
 * enough on its own to name a domain publicly.
 *
 *   contentPasswordField - the page serves somewhere to type a credential.
 *   homoglyphNonAscii    - the name uses look-alike Unicode characters.
 *
 * Both are signals with essentially no innocent reading. Everything else in the
 * model (age, resolution, certificate timing, name similarity) describes things
 * that thousands of legitimate sites also do. A candidate can be very
 * suspicious on those alone, and when it is, it goes to human review rather
 * than straight to the public feed.
 *
 * The practical effect: the ordinary phishing case still auto-publishes,
 * because a working credential-harvest page has a password field by definition.
 * What gets held back is the ambiguous middle, which is exactly where the
 * false positives live.
 */
export const HIGH_TIER_REQUIRED_STRONG_SIGNALS = [
  'content.passwordField',
  'name.homoglyphNonAscii'
] as const;

// ---------------------------------------------------------------------------
// Candidate matching.
// ---------------------------------------------------------------------------

/**
 * Maximum Levenshtein distance from a watchlist term before we stop caring.
 * 2 catches `hdfcbank` -> `hdfcbamk` / `hdfcbanik` / `hdfbank`. 3 starts
 * pulling in genuinely unrelated words, especially for short terms.
 */
export const MAX_EDIT_DISTANCE = 2;

/**
 * Terms shorter than this are only ever matched exactly, never fuzzily.
 * At length 4, an edit distance of 2 means half the string changed - that is
 * not a typo, that is a different word. Protects short terms like `sbi`,
 * `upi`, `bhim`, `npci` from generating floods of noise.
 */
export const MIN_TERM_LENGTH_FOR_FUZZY = 6;

/** Longest label we bother analysing. Guards against pathological inputs. */
export const MAX_LABEL_LENGTH = 63;

// ---------------------------------------------------------------------------
// Verification.
// ---------------------------------------------------------------------------

/** Passive content check: single GET, hard timeout, no retries. */
export const CONTENT_FETCH_TIMEOUT_MS = 8000;

/** Stop reading the body after this much HTML. Phishing pages are small; a
 *  200 MB response is either a mistake or a trap. */
export const CONTENT_MAX_BYTES = 512 * 1024;

/** Redirects followed during the content check. Phishing kits often bounce
 *  once or twice; more than this is a rabbit hole. */
export const CONTENT_MAX_REDIRECTS = 3;

/**
 * Identifies the scanner honestly to anyone reading their logs, and gives them
 * a way to ask us to stop. Required by the passive-only guardrail: a site
 * operator must be able to tell what hit them.
 */
export const SCANNER_USER_AGENT =
  'IndiaTyposquatRadar/0.1 (+https://github.com/sharmajii10/india-typosquat-radar; passive single-GET scanner; non-commercial public-good research)';

/** DNS resolution timeout per lookup type. */
export const DNS_TIMEOUT_MS = 5000;

/** RDAP lookup timeout. */
export const RDAP_TIMEOUT_MS = 6000;

/**
 * Politeness delay between outbound requests to *different* candidate hosts
 * inside a single job run. We never hit the same host twice in a run, so this
 * is about being a good citizen of the network generally, not per-host rate
 * limiting.
 */
export const INTER_REQUEST_DELAY_MS = 250;

/** Delay between crt.sh queries. crt.sh is a free community service run by
 *  Sectigo; hammering it is how free things stop being free. */
export const CRTSH_DELAY_MS = 1500;

/** crt.sh can be slow under load. Generous timeout, and we simply skip the
 *  brand this run if it times out - the next run picks it up. */
export const CRTSH_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------
// Recheck cadence.
//
// A candidate is judged repeatedly, not once. The interval widens as a domain
// proves boring, so attention concentrates on the ones that are changing.
// ---------------------------------------------------------------------------
export const RECHECK_INTERVALS_HOURS = {
  /** Brand new and not yet verified - look again within the hour. */
  new: 1,
  /** Resolves and scored medium/high - it is live and interesting. */
  active: 6,
  /** Resolves but scored low - probably a real unrelated site. */
  quiet: 48,
  /** Does not resolve yet. Most registered lookalikes sit here forever, but
   *  the ones that wake up are exactly the ones worth catching, so we keep
   *  looking, just slowly. */
  dormant: 24
} as const;

/**
 * After this many consecutive rechecks with no DNS resolution and no change,
 * stop rechecking. Keeps the job's working set bounded on a free tier.
 */
export const RETIRE_AFTER_DEAD_RECHECKS = 14;

// ---------------------------------------------------------------------------
// Job batching.
//
// Vercel Hobby caps a serverless function at 10s by default (60s configurable
// via maxDuration on the Node runtime). Every job is therefore written to do a
// bounded slice of work per invocation and rotate, rather than trying to
// finish everything in one run.
// ---------------------------------------------------------------------------
export const POLL_BRANDS_PER_RUN = intFromEnv('POLL_BRANDS_PER_RUN', 4);
export const RECHECK_BATCH_SIZE = intFromEnv('RECHECK_BATCH_SIZE', 25);

/** Stop a job cleanly before the platform kills it mid-write. */
export const JOB_SOFT_DEADLINE_MS = 50_000;

/** Public feed page size. */
export const FEED_PAGE_SIZE = 50;
export const FEED_MAX_PAGE_SIZE = 200;

// ---------------------------------------------------------------------------
// Keywords that, combined with a brand term, indicate credential harvesting
// intent. Used both by the matcher (to catch `sbi-kyc-update.com`, which is
// edit-distance-far from `sbi` but obviously targeted) and by the scorer.
// ---------------------------------------------------------------------------
export const PHISHING_KEYWORDS = [
  'login', 'signin', 'secure', 'security', 'verify', 'verification', 'update',
  'account', 'kyc', 'netbanking', 'onlinebanking', 'banking', 'otp', 'auth',
  'authenticate', 'confirm', 'validate', 'reward', 'refund', 'cashback',
  'offer', 'bonus', 'wallet', 'recharge', 'payment', 'pay', 'upi', 'block',
  'unblock', 'suspend', 'reactivate', 'reactivation', 'alert', 'support',
  'helpdesk', 'customercare', 'care', 'apply', 'form', 'gov', 'portal'
] as const;

/** Hosts that legitimately contain brand names and are not typosquats:
 *  registrars, CDNs, hosting panels, and the big platforms. Matching one of
 *  these suppresses the candidate before it is ever written. */
export const STRUCTURAL_IGNORE_SUFFIXES = [
  'amazonaws.com', 'cloudfront.net', 'azurewebsites.net', 'herokuapp.com',
  'github.io', 'gitlab.io', 'netlify.app', 'vercel.app', 'pages.dev',
  'workers.dev', 'firebaseapp.com', 'web.app', 'appspot.com', 'blogspot.com',
  'wordpress.com', 'wixsite.com', 'weebly.com', 'shopify.com', 'myshopify.com',
  'sharepoint.com', 'salesforce.com', 'force.com', 'zendesk.com',
  'freshdesk.com', 'atlassian.net', 'notion.site', 'googleusercontent.com',
  'akamaized.net', 'fastly.net', 'cloudflare.net', 'sendgrid.net',
  'cpanel.net', 'plesk.page'
] as const;

// ---------------------------------------------------------------------------
function intFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
