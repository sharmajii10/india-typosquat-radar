import {
  HIGH_TIER_MIN_EVIDENCE_CATEGORIES,
  HIGH_TIER_REQUIRED_STRONG_SIGNALS,
  HIGH_TIER_REQUIRES_RESOLUTION,
  TIER_THRESHOLD_HIGH,
  TIER_THRESHOLD_MEDIUM
} from '@/lib/config';
import { findPhishingKeywords } from '@/lib/matching/keywords';
import {
  CERTIFICATE_WEIGHTS,
  CONTENT_WEIGHTS,
  FREE_DV_ISSUERS,
  HOSTING_WEIGHTS,
  INFRASTRUCTURE_WEIGHTS,
  NAME_WEIGHTS,
  REGISTRATION_WEIGHTS,
  WEIGHTS_VERSION
} from '@/lib/scoring/weights';
import type {
  Candidate,
  EvidenceCategory,
  PublishState,
  ScoreResult,
  Signal,
  Tier,
  VerificationBundle
} from '@/lib/types';

/**
 * The risk scoring engine.
 *
 * A weighted sum, kept deliberately simple and legible. Not a model - a model
 * would be more accurate and completely unexplainable, and this tool has to be
 * able to show a domain owner exactly why their name appeared on a public list.
 * Every point that lands in the total is emitted as a `Signal` with a
 * human-readable label, stored on the score row, and rendered in the evidence
 * panel. If a number cannot be explained in one sentence to someone who is
 * angry about it, it does not belong in the score.
 */

export interface ScoreInput {
  candidate: Pick<
    Candidate,
    | 'domain'
    | 'match_kind'
    | 'edit_distance'
    | 'homoglyph_flag'
    | 'homoglyph_detail'
    | 'matched_term'
    | 'cert_issuer'
    | 'cert_issued_at'
  >;
  verification: VerificationBundle;
  brandName: string;
}

export function scoreCandidate(input: ScoreInput): ScoreResult {
  const { candidate, verification } = input;
  const signals: Signal[] = [];

  const add = (
    key: string,
    label: string,
    points: number,
    category: EvidenceCategory,
    detail?: string
  ) => {
    if (points === 0) return;
    signals.push({ key, label, points, category, detail });
  };

  // =========================================================================
  // NAME
  // =========================================================================
  switch (candidate.match_kind) {
    case 'homoglyph':
      add(
        'name.homoglyphNonAscii',
        'Uses look-alike characters from another alphabet',
        NAME_WEIGHTS.homoglyphNonAscii,
        'name',
        describeHomoglyphs(candidate.homoglyph_detail)
      );
      break;
    case 'exact_token':
      add(
        'name.exactToken',
        `Contains the exact brand name "${candidate.matched_term}"`,
        NAME_WEIGHTS.exactToken,
        'name'
      );
      break;
    case 'edit_distance':
      add(
        candidate.edit_distance === 1 ? 'name.editDistance1' : 'name.editDistance2',
        `${candidate.edit_distance} character ${
          candidate.edit_distance === 1 ? 'change' : 'changes'
        } away from "${candidate.matched_term}"`,
        candidate.edit_distance === 1
          ? NAME_WEIGHTS.editDistance1
          : NAME_WEIGHTS.editDistance2,
        'name'
      );
      break;
    case 'substring':
      add(
        'name.substring',
        `Contains "${candidate.matched_term}" inside a longer word`,
        NAME_WEIGHTS.substring,
        'name'
      );
      break;
    case 'keyword_combo':
      add(
        'name.exactToken',
        `Contains the brand name "${candidate.matched_term}"`,
        NAME_WEIGHTS.exactToken,
        'name'
      );
      break;
  }

  // Keyword bonus, independent of match kind.
  const keywords = findPhishingKeywords(candidate.domain);
  if (keywords.length > 0) {
    add(
      'name.phishingKeyword',
      'Combined with words used in credential-theft pages',
      NAME_WEIGHTS.phishingKeyword,
      'name',
      keywords.join(', ')
    );
  }

  // Mixed script, when it is not already the reason for the homoglyph signal.
  if (candidate.homoglyph_detail?.mixedScript && candidate.match_kind !== 'homoglyph') {
    add(
      'name.mixedScript',
      'Mixes characters from more than one alphabet',
      NAME_WEIGHTS.mixedScript,
      'name',
      candidate.homoglyph_detail.scripts.join(' + ')
    );
  }

  // =========================================================================
  // INFRASTRUCTURE
  // =========================================================================
  if (verification.dns.resolves) {
    add(
      'infrastructure.resolves',
      'The domain is live and resolves to a server',
      INFRASTRUCTURE_WEIGHTS.resolves,
      'infrastructure',
      verification.dns.aRecords.slice(0, 3).join(', ')
    );
  }
  if (verification.dns.hasMx) {
    add(
      'infrastructure.hasMx',
      'Configured to send and receive email',
      INFRASTRUCTURE_WEIGHTS.hasMx,
      'infrastructure'
    );
  }

  // =========================================================================
  // REGISTRATION
  // =========================================================================
  const age = verification.rdap.ageDays;
  if (age !== null) {
    if (age < 3) {
      add('registration.ageUnder3Days', `Registered ${plural(age, 'day')} ago`, REGISTRATION_WEIGHTS.ageUnder3Days, 'registration');
    } else if (age < 7) {
      add('registration.ageUnder7Days', `Registered ${plural(age, 'day')} ago`, REGISTRATION_WEIGHTS.ageUnder7Days, 'registration');
    } else if (age < 30) {
      add('registration.ageUnder30Days', `Registered ${plural(age, 'day')} ago`, REGISTRATION_WEIGHTS.ageUnder30Days, 'registration');
    } else if (age < 90) {
      add('registration.ageUnder90Days', `Registered ${plural(age, 'day')} ago`, REGISTRATION_WEIGHTS.ageUnder90Days, 'registration');
    } else if (age > 365) {
      // Mitigating: filed under its own category so it can never be counted
      // toward the "independent evidence categories" requirement.
      add(
        'registration.ageOver1Year',
        `Registered over ${Math.floor(age / 365)} year${age >= 730 ? 's' : ''} ago, which is unusual for phishing infrastructure`,
        REGISTRATION_WEIGHTS.ageOver1Year,
        'mitigating'
      );
    }
  }

  // =========================================================================
  // CONTENT
  // =========================================================================
  const content = verification.content;
  if (content.hasPasswordField) {
    add(
      'content.passwordField',
      'The page asks visitors for a password or PIN',
      CONTENT_WEIGHTS.passwordField,
      'content'
    );
  }
  if (content.brandTermsOnPage.length > 0) {
    add(
      'content.brandOnPage',
      `The page uses the brand's name (${input.brandName})`,
      CONTENT_WEIGHTS.brandOnPage,
      'content',
      content.brandTermsOnPage.join(', ')
    );
  }
  if (content.hasPasswordField && content.brandTermsOnPage.length > 0) {
    add(
      'content.passwordAndBrand',
      'It both impersonates the brand and asks for credentials',
      CONTENT_WEIGHTS.passwordAndBrand,
      'content'
    );
  }
  if (content.formPostsOffsite) {
    add(
      'content.formPostsOffsite',
      'A form on the page sends what you type to a different website',
      CONTENT_WEIGHTS.formPostsOffsite,
      'content'
    );
  }
  if (content.looksParked) {
    add(
      'content.looksParked',
      'The page is parked or for sale rather than a working site',
      CONTENT_WEIGHTS.looksParked,
      'mitigating'
    );
  }

  // =========================================================================
  // CERTIFICATE
  // =========================================================================
  const certGap = certRegistrationGapDays(
    candidate.cert_issued_at,
    verification.rdap.createdAt
  );
  if (certGap !== null && certGap <= 0) {
    add(
      'certificate.certSameDayAsRegistration',
      'A TLS certificate was issued the same day the domain was registered',
      CERTIFICATE_WEIGHTS.certSameDayAsRegistration,
      'certificate'
    );
  } else if (certGap !== null && certGap <= 3) {
    add(
      'certificate.certWithin3Days',
      `A TLS certificate was issued ${plural(certGap, 'day')} after registration`,
      CERTIFICATE_WEIGHTS.certWithin3Days,
      'certificate'
    );
  }
  if (isFreeDvIssuer(candidate.cert_issuer)) {
    add(
      'certificate.freeDvIssuer',
      'The certificate came from a free, fully automated issuer',
      CERTIFICATE_WEIGHTS.freeDvIssuer,
      'certificate',
      candidate.cert_issuer ?? undefined
    );
  }

  // =========================================================================
  // HOSTING - zero at MVP, see lib/verify/asn.ts
  // =========================================================================
  if (verification.asn.reputationScore !== null && verification.asn.reputationScore > 50) {
    add(
      'hosting.knownAbusedAsn',
      'Hosted on a network with a history of abuse',
      HOSTING_WEIGHTS.knownAbusedAsn,
      'hosting',
      verification.asn.asnOrg ?? verification.asn.asn ?? undefined
    );
  }

  // =========================================================================
  // TOTAL AND GATE
  // =========================================================================
  const raw = signals.reduce((sum, s) => sum + s.points, 0);
  const score = Math.max(0, Math.min(100, raw));

  // Only positive, non-mitigating categories count as evidence.
  const categories = [
    ...new Set(
      signals.filter((s) => s.points > 0 && s.category !== 'mitigating').map((s) => s.category)
    )
  ];

  const { tier, gateNote } = applyGates({
    score,
    categories,
    signals,
    resolves: verification.dns.resolves
  });

  return { score, tier, signals, categories, weightsVersion: WEIGHTS_VERSION, gateNote };
}

/**
 * Confidence gating.
 *
 * The numeric thresholds decide the ceiling; the hard gates can only ever pull a
 * candidate DOWN, never up. That direction is the whole safety property: a bug
 * in a gate makes the tool quieter, not louder.
 */
function applyGates(args: {
  score: number;
  categories: EvidenceCategory[];
  signals: Signal[];
  resolves: boolean;
}): { tier: Tier; gateNote?: string } {
  const { score, categories, signals, resolves } = args;

  let tier: Tier =
    score >= TIER_THRESHOLD_HIGH
      ? 'high'
      : score >= TIER_THRESHOLD_MEDIUM
        ? 'medium'
        : 'low';

  if (tier !== 'high') return { tier };

  // Gate 1: must be live.
  if (HIGH_TIER_REQUIRES_RESOLUTION && !resolves) {
    return {
      tier: 'medium',
      gateNote:
        'Held below high confidence: the domain does not currently resolve, so nobody can be reaching it yet.'
    };
  }

  // Gate 2: at least N independent evidence categories.
  if (categories.length < HIGH_TIER_MIN_EVIDENCE_CATEGORIES) {
    return {
      tier: 'medium',
      gateNote: `Held below high confidence: only ${categories.length} independent kind${
        categories.length === 1 ? '' : 's'
      } of evidence (${categories.join(', ')}). High confidence needs at least ${HIGH_TIER_MIN_EVIDENCE_CATEGORIES}.`
    };
  }

  // Gate 3: at least one signal with no innocent reading.
  const keys = new Set(signals.filter((s) => s.points > 0).map((s) => s.key));
  const hasStrong = HIGH_TIER_REQUIRED_STRONG_SIGNALS.some((k) => keys.has(k));
  if (!hasStrong) {
    return {
      tier: 'medium',
      gateNote:
        'Held below high confidence: nothing here is conclusive on its own. Queued for human review.'
    };
  }

  return { tier: 'high' };
}

/**
 * Map a tier to what the public actually sees.
 *
 * `cleared` is never produced here - only a human sets it, and once set it is
 * sticky, so a domain someone successfully disputed cannot be re-published by a
 * later scoring run.
 */
export function publishStateForTier(
  tier: Tier,
  currentState: PublishState
): PublishState {
  if (currentState === 'cleared') return 'cleared';
  if (tier === 'high') return 'published';
  if (tier === 'medium') return 'pending_review';
  return 'hidden';
}

// ---------------------------------------------------------------------------
function describeHomoglyphs(
  detail: Candidate['homoglyph_detail']
): string | undefined {
  if (!detail || detail.substitutions.length === 0) return undefined;
  return detail.substitutions
    .filter((s) => (s.from.codePointAt(0) ?? 0) > 0x7f)
    .map((s) => `${s.from} (${s.codepoint}) looks like "${s.to}"`)
    .join('; ');
}

function certRegistrationGapDays(
  certIssuedAt: string | null,
  registeredAt: string | null
): number | null {
  if (!certIssuedAt || !registeredAt) return null;
  const cert = new Date(certIssuedAt).getTime();
  const reg = new Date(registeredAt).getTime();
  if (Number.isNaN(cert) || Number.isNaN(reg)) return null;
  return Math.floor((cert - reg) / 86400_000);
}

function isFreeDvIssuer(issuer: string | null): boolean {
  if (!issuer) return false;
  const lower = issuer.toLowerCase();
  return FREE_DV_ISSUERS.some((name) => lower.includes(name));
}

function plural(n: number, unit: string): string {
  const rounded = Math.max(0, Math.round(n));
  return `${rounded} ${unit}${rounded === 1 ? '' : 's'}`;
}
