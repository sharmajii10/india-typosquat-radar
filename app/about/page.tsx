import Link from 'next/link';
import {
  HIGH_TIER_MIN_EVIDENCE_CATEGORIES,
  TIER_THRESHOLD_HIGH,
  TIER_THRESHOLD_MEDIUM
} from '@/lib/config';

export const metadata = {
  title: 'How it works - India Typosquat Radar'
};

/**
 * The methodology page. Thresholds are imported from lib/config rather than
 * written out, so this page cannot drift out of date when someone retunes them.
 */
export default function AboutPage() {
  return (
    <div className="prose">
      <h1>How this works</h1>
      <p>
        Every TLS certificate issued by a public authority is written to
        Certificate Transparency logs, which anyone can read. When someone registers a
        domain to impersonate a bank and puts HTTPS on it, that certificate becomes public
        within minutes. This project watches those logs for names that resemble Indian
        banks, payment apps and government portals, then checks each one before saying
        anything about it.
      </p>

      <h2>Why name similarity is not enough</h2>
      <p>
        A domain that looks like a brand name is a weak signal on its own. Plenty of real,
        unrelated businesses have names that overlap with a bank&rsquo;s: a consultancy
        that shares an acronym, a vendor, a fan site, a local shop. Publishing on name
        similarity alone would mean accusing those businesses in public, at scale, on the
        basis of a string comparison.
      </p>
      <p>
        So name matching only produces a <em>candidate</em>. Nothing is shown publicly
        until independent checks have been run against it.
      </p>

      <h2>The checks</h2>
      <ol>
        <li>
          <strong>Does it resolve?</strong> Most registered lookalikes are never pointed at
          a server. A domain with no address is not currently harming anyone, and it is not
          published as though it were.
        </li>
        <li>
          <strong>How old is the registration?</strong> Read from RDAP, the public registry
          protocol. Phishing domains are usually used within days of being bought. A domain
          that has existed for years and matches a brand name is treated as
          <em> less</em> suspicious, not more, because that is what a real unrelated
          business looks like.
        </li>
        <li>
          <strong>What does the page serve?</strong> One passive request, no interaction, no
          login attempt, checking whether the page asks for a password and whether it uses
          the brand&rsquo;s name. A page that does both has no innocent explanation, and
          this is the strongest evidence available.
        </li>
        <li>
          <strong>When was the certificate issued?</strong> A certificate pulled the same
          day the domain was registered fits the automated phishing-kit pattern. Weighted
          lightly, because automatic HTTPS provisioning does exactly the same thing for
          legitimate sites.
        </li>
      </ol>

      <h2>How the score becomes a listing</h2>
      <p>
        Each signal contributes points to a score out of 100. Thresholds:
      </p>
      <ul>
        <li>
          <strong>{TIER_THRESHOLD_HIGH} and above</strong> is published as a high-confidence
          detection.
        </li>
        <li>
          <strong>{TIER_THRESHOLD_MEDIUM} to {TIER_THRESHOLD_HIGH - 1}</strong> is shown as
          unconfirmed and queued for a person to review.
        </li>
        <li>
          <strong>Below {TIER_THRESHOLD_MEDIUM}</strong> is never shown publicly at all. It
          is kept internally and re-checked, in case the domain becomes active later.
        </li>
      </ul>
      <p>
        Three further gates sit on top of the number, and all three can only ever hold a
        domain back, never push it forward. To be published as high confidence a domain
        must also resolve, must have at least {HIGH_TIER_MIN_EVIDENCE_CATEGORIES}{' '}
        independent kinds of evidence, and must have at least one signal with no innocent
        reading &mdash; a password field on the page, or look-alike characters in the name.
        The arithmetic is arranged so that name similarity alone can never reach the
        publication threshold, no matter how close the resemblance.
      </p>

      <h2>Nothing is judged once</h2>
      <p>
        Every candidate is re-checked on a schedule. A domain registered today and left
        parked may go live in three weeks; a live phishing page may be taken down tomorrow.
        Listings move up and down accordingly, and a domain that stops resolving drops off
        the feed on its own.
      </p>

      <h2>What this does not do</h2>
      <ul>
        <li>
          It does not determine intent. It records what was observed. Any listing here is
          evidence, not a verdict, and never an allegation about a person.
        </li>
        <li>
          It does not attack, probe, scan ports, log in, or submit anything to the domains
          it checks. One ordinary GET request, identifying itself honestly, and nothing
          else.
        </li>
        <li>
          It cannot take a site down. If you are dealing with an active phishing site,
          report it to the affected bank and to India&rsquo;s National Cyber Crime
          Reporting Portal.
        </li>
        <li>
          It will sometimes be wrong. That is why{' '}
          <Link href="/report">the dispute form</Link> exists and why every listing shows
          its full evidence.
        </li>
      </ul>

      <h2>Data sources</h2>
      <ul>
        <li>Certificate Transparency logs, via crt.sh</li>
        <li>Public DNS</li>
        <li>RDAP, the registry protocol that replaced WHOIS</li>
        <li>A single passive HTTP request to the candidate domain</li>
      </ul>
      <p>
        All of them are free and public. There is no commercial data feed behind this, no
        account to create, and nothing for sale.
      </p>

      <h2>Corrections</h2>
      <p>
        If a domain here is yours, <Link href="/report">use the dispute form</Link>. Listings
        found to be wrong are removed and permanently allowlisted, so the same domain
        cannot be flagged again by a later scan.
      </p>
    </div>
  );
}
