/**
 * Seeds the brand watchlist and the allowlist.
 *
 * Idempotent - safe to run repeatedly. Existing brands are updated in place, so
 * this is also how you push watchlist edits after changing the data below.
 *
 *   npm run seed
 *
 * Adding a brand: append an entry to BRAND_SEED and re-run. See the README
 * section "Adding a brand to the watchlist" for what each field does and how to
 * choose match terms that do not generate noise.
 */

// Must come first - it installs the WebSocket global that supabase-js needs on
// Node 20. See scripts/_bootstrap.ts.
import './_bootstrap';

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import {
  SUPABASE_HINT,
  SUPABASE_SECRET_KEYS,
  SUPABASE_URL_KEYS,
  readEnv
} from '../lib/env';
import { deriveMatchTerms } from '../lib/matching/terms';

config({ path: '.env.local' });
config({ path: '.env' });

interface BrandSeed {
  name: string;
  slug: string;
  category: 'bank' | 'payment' | 'government' | 'other';
  officialDomains: string[];
  aliases: string[];
  /**
   * Terms to match on that would not be derived from the name or domains, and
   * terms to suppress because deriving them would be too broad.
   *
   * `extraTerms` is where you put the way people actually type a brand -
   * `netbanking`, `gpay` - rather than its legal name.
   *
   * `excludeTerms` matters more than it looks. Google Pay's official domain is
   * pay.google.com, whose registrable label is `google` - matching on that would
   * flag every Google-adjacent domain on the internet. Suppress it and match on
   * `googlepay` and `gpay` instead.
   */
  extraTerms?: string[];
  excludeTerms?: string[];
}

/**
 * ---------------------------------------------------------------------------
 * THE WATCHLIST
 * ---------------------------------------------------------------------------
 * Choosing match terms is the highest-leverage false-positive control in the
 * whole project, ahead of any scoring weight. Two rules:
 *
 *   1. Prefer specific over short. `hdfcbank` is a good term. `hdfc` alone is
 *      workable because it is distinctive; `bank`, `pay` or `sbi`-length generic
 *      strings are not, and short terms are only ever matched as whole words
 *      (see MIN_TERM_LENGTH_FOR_FUZZY and MIN_TERM_LENGTH_FOR_SUBSTRING).
 *   2. Never add a term that is an ordinary English or Hindi word. It will match
 *      thousands of unrelated domains and bury everything real.
 */
const BRAND_SEED: BrandSeed[] = [
  // --- Banks ---------------------------------------------------------------
  {
    name: 'State Bank of India',
    slug: 'sbi',
    category: 'bank',
    officialDomains: ['sbi.co.in', 'onlinesbi.sbi', 'onlinesbi.com', 'sbi.bank.in'],
    aliases: ['sbi', 'onlinesbi', 'statebankofindia', 'yonosbi'],
    // `statebankofindia` is derived from the name and is a fine long term.
    extraTerms: ['sbicard', 'sbiyono', 'yono']
  },
  {
    name: 'HDFC Bank',
    slug: 'hdfc-bank',
    category: 'bank',
    officialDomains: ['hdfcbank.com', 'hdfcbank.net.in', 'hdfcbank.bank.in'],
    aliases: ['hdfc', 'hdfcbank'],
    extraTerms: ['hdfcnetbanking']
  },
  {
    name: 'ICICI Bank',
    slug: 'icici-bank',
    category: 'bank',
    officialDomains: ['icicibank.com', 'icicibank.bank.in'],
    aliases: ['icici', 'icicibank'],
    extraTerms: ['icicidirect', 'imobile']
  },
  {
    name: 'Axis Bank',
    slug: 'axis-bank',
    category: 'bank',
    officialDomains: ['axisbank.com', 'axisbank.bank.in'],
    aliases: ['axisbank'],
    // `axis` on its own is an ordinary English word - it would match hundreds of
    // unrelated engineering, media and logistics companies.
    excludeTerms: ['axis']
  },
  {
    name: 'Kotak Mahindra Bank',
    slug: 'kotak',
    category: 'bank',
    officialDomains: ['kotak.com', 'kotak.bank.in', 'kotaksecurities.com'],
    aliases: ['kotak', 'kotakbank', 'kotakmahindra'],
    excludeTerms: ['kotakmahindrabank']
  },
  {
    name: 'Punjab National Bank',
    slug: 'pnb',
    category: 'bank',
    // pnbnet.org.in has no A record of its own but is delegated to PNB's own
    // nameservers, which is what makes it verifiably theirs rather than a
    // lookalike somebody else parked.
    officialDomains: ['pnbindia.in', 'pnb.bank.in', 'pnbnet.org.in'],
    aliases: ['pnb', 'pnbindia', 'pnbnet'],
    // `pnb` is three characters, so it only ever matches as a whole token -
    // `pnb-kyc.in` matches, `pnbhousing.com` does not. That is the behaviour we
    // want: the group companies are a different business.
    extraTerms: ['pnbnetbanking']
  },
  {
    name: 'Bank of Baroda',
    slug: 'bank-of-baroda',
    category: 'bank',
    officialDomains: [
      'bankofbaroda.in',
      'bankofbaroda.co.in',
      'bankofbaroda.bank.in',
      'bobibanking.com'
    ],
    aliases: ['bob', 'bankofbaroda', 'bobibanking'],
    extraTerms: ['bobworld'],
    // `bob` is a name, a word, and three characters. It would match thousands of
    // unrelated domains and bury everything real.
    excludeTerms: ['bob']
  },
  {
    name: 'Canara Bank',
    slug: 'canara-bank',
    category: 'bank',
    officialDomains: ['canarabank.com', 'canarabank.bank.in'],
    aliases: ['canara', 'canarabank'],
    extraTerms: ['canaranetbanking'],
    // `canara` is one edit from `canary`, and AWS issues certificates for
    // `canary.s3.<region>.vpce.amazonaws.com` in enormous volume. Left in, it
    // took the CT pre-filter from 0.033% of entries to 1.63% - a 49x increase,
    // essentially all of it AWS health-check endpoints. The rule against
    // ordinary English words has to extend to terms within two edits of one.
    excludeTerms: ['canara']
  },
  {
    name: 'Union Bank of India',
    slug: 'union-bank',
    category: 'bank',
    officialDomains: ['unionbankofindia.co.in', 'unionbankonline.co.in'],
    aliases: ['unionbankofindia', 'unionbankonline'],
    // Note what is NOT here: `union`. The term deriver only ever collapses the
    // whole brand name, so `union` is never generated - but adding it as an
    // alias would, and it is an ordinary English word. `unionbanking` is out
    // for the same reason at one remove: it is a substring of
    // `creditunionbanking.com`, and credit unions are a real industry.
    excludeTerms: ['union']
  },
  {
    name: 'Yes Bank',
    slug: 'yes-bank',
    category: 'bank',
    officialDomains: ['yesbank.in'],
    // `yesbank` only. `yes` on its own would be the single worst term in this
    // file - it is one of the most common words in English. `yesonline` is out
    // too: it looks specific but sits inside `sayyesonline.com` and similar.
    aliases: ['yesbank']
  },
  {
    name: 'IDFC First Bank',
    slug: 'idfc-first',
    category: 'bank',
    officialDomains: ['idfcfirstbank.com'],
    aliases: ['idfc', 'idfcfirst', 'idfcfirstbank']
  },
  {
    name: 'IndusInd Bank',
    slug: 'indusind',
    category: 'bank',
    officialDomains: ['indusind.com', 'indusind.bank.in'],
    aliases: ['indusind', 'indusindbank']
  },

  // --- Payments ------------------------------------------------------------
  {
    name: 'PhonePe',
    slug: 'phonepe',
    category: 'payment',
    officialDomains: ['phonepe.com', 'phon.pe'],
    aliases: ['phonepe'],
    // `phon.pe` is a real PhonePe domain, but its registrable label is `phon`,
    // which the term deriver would otherwise add to the watchlist. Four generic
    // characters would match unrelated domains like `phon-repair.com` on the
    // whole-token rule and generate pure noise.
    excludeTerms: ['phon']
  },
  {
    name: 'Google Pay',
    slug: 'google-pay',
    category: 'payment',
    officialDomains: ['pay.google.com', 'google.com', 'gpay.app'],
    aliases: ['googlepay', 'gpay'],
    // See the excludeTerms note above - `google` would be catastrophically broad.
    excludeTerms: ['google']
  },
  {
    name: 'Paytm',
    slug: 'paytm',
    category: 'payment',
    officialDomains: ['paytm.com', 'paytm.in', 'paytmbank.com'],
    aliases: ['paytm'],
    extraTerms: ['paytmbank', 'paytmkyc']
  },
  {
    name: 'NPCI / UPI',
    slug: 'npci-upi',
    category: 'payment',
    officialDomains: ['npci.org.in', 'upichalega.com'],
    aliases: ['npci', 'upi'],
    // "NPCI / UPI" collapses to `npciupi`, which is not a string anyone will
    // ever register. Harmless but pure noise in the watchlist.
    excludeTerms: ['npciupi'],
    // `upi` is three characters, so it only ever matches as a whole word - e.g.
    // `upi-verify.com` matches, `occupied.com` does not.
    extraTerms: ['upipay', 'upiid', 'bharatupi']
  },
  {
    name: 'RuPay',
    slug: 'rupay',
    category: 'payment',
    officialDomains: ['rupay.co.in'],
    aliases: ['rupay']
  },
  {
    name: 'BHIM',
    slug: 'bhim',
    category: 'payment',
    officialDomains: ['bhimupi.org.in'],
    aliases: ['bhim', 'bhimupi'],
    extraTerms: ['bhimapp']
  },
  {
    name: 'Airtel Payments Bank',
    slug: 'airtel-payments-bank',
    category: 'payment',
    officialDomains: ['airtelbank.com', 'airtel.in'],
    aliases: ['airtel', 'airtelbank', 'airtelpaymentsbank'],
    // `airtel` is six characters and a coined brand name rather than a word, so
    // it is safe to match fuzzily and as a substring. It does pull in Airtel's
    // telecom estate, which is why airtel.com is allowlisted below.
    extraTerms: ['airtelmoney', 'airtelthanks']
  },
  {
    name: 'Amazon Pay',
    slug: 'amazon-pay',
    category: 'payment',
    // Deliberately NOT amazon.in. Its registrable label is `amazon`, which the
    // deriver would turn into a match term covering every Amazon-adjacent
    // domain on the internet - the same trap as pay.google.com under Google Pay.
    officialDomains: ['amazonpay.in'],
    aliases: ['amazonpay'],
    excludeTerms: ['amazon']
  },
  {
    name: 'MobiKwik',
    slug: 'mobikwik',
    category: 'payment',
    officialDomains: ['mobikwik.com'],
    aliases: ['mobikwik'],
    extraTerms: ['mobikwikwallet']
  },
  {
    name: 'CRED',
    slug: 'cred',
    category: 'payment',
    officialDomains: ['cred.club'],
    // `cred` is four characters, so whole-token matching only: `cred-upi.in`
    // matches, `credit-union.com` does not, because `credit` is a different
    // token rather than a string containing this one.
    aliases: ['cred', 'credclub'],
    extraTerms: ['credupi']
  },

  // --- Government ----------------------------------------------------------
  {
    name: 'DigiLocker',
    slug: 'digilocker',
    category: 'government',
    officialDomains: ['digilocker.gov.in', 'digitallocker.gov.in'],
    aliases: ['digilocker', 'digitallocker']
  },
  {
    name: 'Income Tax e-Filing',
    slug: 'income-tax',
    category: 'government',
    officialDomains: ['incometax.gov.in', 'incometaxindia.gov.in', 'incometaxindiaefiling.gov.in'],
    aliases: ['incometax', 'efiling'],
    extraTerms: ['incometaxrefund', 'itrfiling'],
    // `efiling` on its own is generic enough to match unrelated legal and
    // corporate-filing services worldwide.
    excludeTerms: ['efiling']
  },
  {
    name: 'UIDAI / Aadhaar',
    slug: 'uidai-aadhaar',
    category: 'government',
    officialDomains: ['uidai.gov.in', 'myaadhaar.uidai.gov.in'],
    aliases: ['uidai', 'aadhaar', 'aadhar'],
    // Same artifact as npciupi: "UIDAI / Aadhaar" collapses to `uidaiaadhaar`.
    excludeTerms: ['uidaiaadhaar'],
    extraTerms: ['myaadhaar', 'aadhaarcard', 'eaadhaar']
  },
  {
    name: 'IRCTC',
    slug: 'irctc',
    category: 'government',
    officialDomains: ['irctc.co.in', 'irctc.com', 'indianrail.gov.in'],
    aliases: ['irctc'],
    extraTerms: ['irctctourism']
  }
];

/**
 * Additional domains that are legitimately operated by these organisations but
 * are not the primary domain. Without these, the pipeline would flag a bank's
 * own campaign or subsidiary sites.
 *
 * This list should grow over time - most entries will come from disputes, which
 * is the intended feedback loop. Anything added here is permanently invisible to
 * the matcher, so add deliberately.
 */
const ALLOWLIST_SEED: Array<{ domain: string; slug: string; reason: string }> = [
  { domain: 'sbicard.com', slug: 'sbi', reason: 'SBI Cards, an SBI group company' },
  { domain: 'sbilife.co.in', slug: 'sbi', reason: 'SBI Life Insurance, an SBI group company' },
  { domain: 'sbigeneral.in', slug: 'sbi', reason: 'SBI General Insurance' },
  { domain: 'hdfclife.com', slug: 'hdfc-bank', reason: 'HDFC Life Insurance' },
  { domain: 'hdfcsec.com', slug: 'hdfc-bank', reason: 'HDFC Securities' },
  { domain: 'hdfcergo.com', slug: 'hdfc-bank', reason: 'HDFC ERGO General Insurance' },
  { domain: 'icicidirect.com', slug: 'icici-bank', reason: 'ICICI Securities' },
  { domain: 'icicilombard.com', slug: 'icici-bank', reason: 'ICICI Lombard General Insurance' },
  { domain: 'iciciprulife.com', slug: 'icici-bank', reason: 'ICICI Prudential Life Insurance' },
  { domain: 'axismf.com', slug: 'axis-bank', reason: 'Axis Mutual Fund' },
  { domain: 'axisdirect.in', slug: 'axis-bank', reason: 'Axis Direct' },
  { domain: 'kotaklife.com', slug: 'kotak', reason: 'Kotak Life Insurance' },
  { domain: 'kotaksecurities.com', slug: 'kotak', reason: 'Kotak Securities' },
  { domain: 'paytmmoney.com', slug: 'paytm', reason: 'Paytm Money' },
  { domain: 'paytminsurance.co.in', slug: 'paytm', reason: 'Paytm Insurance' },
  { domain: 'npciinternational.com', slug: 'npci-upi', reason: 'NPCI International Payments' },
  { domain: 'bharatbillpay.com', slug: 'npci-upi', reason: 'Bharat BillPay, an NPCI service' },
  { domain: 'nsdl.co.in', slug: 'income-tax', reason: 'NSDL, an authorised tax intermediary' },
  { domain: 'utiitsl.com', slug: 'income-tax', reason: 'UTIITSL, an authorised PAN service provider' },
  { domain: 'irctctourism.com', slug: 'irctc', reason: 'IRCTC Tourism, official' },
  { domain: 'irctcair.com', slug: 'irctc', reason: 'IRCTC Air, official' },
  // The three below are load-bearing rather than decorative: `canara` and
  // `airtel` are long enough to match as substrings, so without these entries
  // the matcher would flag each company's own group sites as lookalikes of
  // itself on the first scan that saw them.
  { domain: 'canarahsbclife.com', slug: 'canara-bank', reason: 'Canara HSBC Life Insurance, a Canara Bank joint venture' },
  { domain: 'canararobeco.com', slug: 'canara-bank', reason: 'Canara Robeco Mutual Fund, a Canara Bank joint venture' },
  { domain: 'airtel.com', slug: 'airtel-payments-bank', reason: 'Bharti Airtel global site, parent of Airtel Payments Bank' },
  { domain: 'pnbhousing.com', slug: 'pnb', reason: 'PNB Housing Finance, a PNB group company' },
  { domain: 'pnbmetlife.com', slug: 'pnb', reason: 'PNB MetLife Insurance, a PNB group company' }
];

async function main() {
  // Seeding writes the watchlist, so it needs the SECRET key. The publishable
  // key is blocked from writing by Row Level Security, by design.
  const url = readEnv(SUPABASE_URL_KEYS);
  const key = readEnv(SUPABASE_SECRET_KEYS);

  if (!url || !key) {
    console.error(
      [
        'Missing Supabase configuration.',
        '',
        `  Project URL: set ${SUPABASE_URL_KEYS.join(' or ')}`,
        `  Secret key:  set ${SUPABASE_SECRET_KEYS.join(' or ')}`,
        '',
        `Both are in the ${SUPABASE_HINT}`,
        'Copy .env.example to .env.local and fill them in first.'
      ].join('\n')
    );
    process.exit(1);
  }

  const db = createClient(url, key, { auth: { persistSession: false } });
  const slugToId = new Map<string, string>();

  console.log(`Seeding ${BRAND_SEED.length} brands...\n`);

  for (const brand of BRAND_SEED) {
    const derived = deriveMatchTerms(brand.name, brand.officialDomains, brand.aliases);
    const excluded = new Set((brand.excludeTerms ?? []).map((t) => t.toLowerCase()));

    const matchTerms = [...new Set([...derived, ...(brand.extraTerms ?? [])])]
      .map((t) => t.toLowerCase())
      .filter((t) => t.length >= 3 && !excluded.has(t))
      .sort((a, b) => b.length - a.length);

    const { data, error } = await db
      .from('brands')
      .upsert(
        {
          name: brand.name,
          slug: brand.slug,
          category: brand.category,
          official_domains: brand.officialDomains,
          aliases: brand.aliases,
          match_terms: matchTerms,
          active: true
        },
        { onConflict: 'slug' }
      )
      .select('id')
      .single();

    if (error) {
      console.error(`  ${brand.name}: FAILED - ${error.message}`);
      continue;
    }

    slugToId.set(brand.slug, data.id as string);
    console.log(`  ${brand.name.padEnd(24)} terms: ${matchTerms.join(', ')}`);
  }

  console.log(`\nSeeding ${ALLOWLIST_SEED.length} allowlist entries...`);

  const allowRows = ALLOWLIST_SEED.map((entry) => ({
    domain: entry.domain,
    brand_id: slugToId.get(entry.slug) ?? null,
    reason: entry.reason,
    added_by: 'seed'
  }));

  const { error: allowErr } = await db
    .from('allowlist')
    .upsert(allowRows, { onConflict: 'domain' });

  if (allowErr) {
    console.error(`  allowlist FAILED - ${allowErr.message}`);
  } else {
    console.log(`  ${allowRows.length} entries written.`);
  }

  console.log('\nDone. Next: trigger a poll run to start ingesting candidates.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
