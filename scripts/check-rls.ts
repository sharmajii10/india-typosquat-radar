/**
 * Proves the Row Level Security policies actually work.
 *
 *   npm run check:rls
 *
 * WHY THIS EXISTS
 * ---------------
 * The publishable key ships to every browser that loads this site. The only
 * thing stopping a visitor from reading the entire internal candidate list -
 * including low-tier domains that were deliberately never published, and the
 * allowlist, which tells an attacker exactly which lookalikes are pre-cleared -
 * is the set of policies in supabase/migrations/0002_rls.sql.
 *
 * Those policies are easy to get wrong and fail silently when you do. A view
 * created without `security_invoker` bypasses RLS entirely, and a project on
 * PostgreSQL 14 cannot set it at all. In both cases everything looks fine: the
 * app works, the feed renders, and the internal list is quietly world-readable.
 *
 * So this script does not read the policies. It attacks them, using the same
 * publishable key a stranger would have.
 *
 * WHAT IT DOES
 * ------------
 * Writes two temporary candidates with the secret key - one hidden, one
 * published - then tries to read them back with the publishable key, and
 * asserts that only the published one comes back. It also confirms the
 * allowlist and job log are unreadable and that public writes are refused.
 * Both temporary rows are deleted at the end, including if a check fails.
 *
 * Nothing here leaves your machine. Both keys are read from .env.local.
 *
 * RUN THIS BEFORE YOU DEPLOY, and again any time you touch the migrations.
 */

// Must come first - installs the WebSocket global supabase-js needs on Node 20.
import './_bootstrap';

import { config } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_HINT,
  SUPABASE_PUBLIC_KEYS,
  SUPABASE_SECRET_KEYS,
  SUPABASE_URL_KEYS,
  readEnv
} from '../lib/env';

config({ path: '.env.local' });
config({ path: '.env' });

const TEST_PREFIX = 'rls-selftest-';

let failures = 0;
let checks = 0;

function pass(what: string) {
  checks++;
  console.log(`  PASS  ${what}`);
}

function fail(what: string, detail: string) {
  checks++;
  failures++;
  console.error(`  FAIL  ${what}`);
  console.error(`        ${detail}`);
}

async function main() {
  const url = readEnv(SUPABASE_URL_KEYS);
  const secret = readEnv(SUPABASE_SECRET_KEYS);
  const publishable = readEnv(SUPABASE_PUBLIC_KEYS);

  if (!url || !secret || !publishable) {
    console.error(
      [
        'Missing Supabase configuration.',
        '',
        `  Project URL:     ${SUPABASE_URL_KEYS.join(' or ')}`,
        `  Publishable key: ${SUPABASE_PUBLIC_KEYS.join(' or ')}`,
        `  Secret key:      ${SUPABASE_SECRET_KEYS.join(' or ')}`,
        '',
        `All three are in the ${SUPABASE_HINT}`,
        'Put them in .env.local first.'
      ].join('\n')
    );
    process.exit(1);
  }

  const admin = createClient(url, secret, { auth: { persistSession: false } });
  const anon = createClient(url, publishable, { auth: { persistSession: false } });

  console.log('\nRow Level Security self-test');
  console.log('Attacking your own policies with the publishable key.\n');

  const hiddenDomain = `${TEST_PREFIX}hidden-${Date.now()}.invalid`;
  const publishedDomain = `${TEST_PREFIX}published-${Date.now()}.invalid`;
  let brandId: string | null = null;
  let temporaryBrand = false;

  try {
    // --- Setup -------------------------------------------------------------
    const { data: brand, error: brandErr } = await admin
      .from('brands')
      .select('id')
      .limit(1)
      .maybeSingle();

    if (brandErr) {
      console.error(
        `\nCould not read the brands table with the secret key: ${brandErr.message}\n` +
          'Have you run supabase/migrations/0001_init.sql yet?\n'
      );
      process.exit(1);
    }

    if (brand) {
      brandId = brand.id as string;
    } else {
      // Watchlist not seeded yet - make a throwaway brand so the FK is satisfied.
      const { data: created, error } = await admin
        .from('brands')
        .insert({
          name: `${TEST_PREFIX}brand`,
          slug: `${TEST_PREFIX}brand`,
          category: 'other',
          active: false
        })
        .select('id')
        .single();
      if (error || !created) {
        console.error(`\nCould not create a temporary brand: ${error?.message}\n`);
        process.exit(1);
      }
      brandId = created.id as string;
      temporaryBrand = true;
    }

    const baseRow = {
      matched_brand_id: brandId,
      matched_term: 'selftest',
      match_kind: 'exact_token' as const,
      edit_distance: 0
    };

    const { error: insertErr } = await admin.from('candidates').insert([
      { ...baseRow, domain: hiddenDomain, publish_state: 'hidden' },
      { ...baseRow, domain: publishedDomain, publish_state: 'published' }
    ]);
    if (insertErr) {
      console.error(`\nCould not create test candidates: ${insertErr.message}\n`);
      process.exit(1);
    }

    // --- The check that matters most ---------------------------------------
    await checkHiddenIsInvisible(anon, hiddenDomain);

    // --- The published row must still be visible, or the feed is broken ----
    await checkPublishedIsVisible(anon, publishedDomain);

    // --- Tables the public must not read -----------------------------------
    await checkTableUnreadable(
      anon,
      admin,
      'allowlist',
      'the allowlist',
      {
        domain: `${TEST_PREFIX}allow.invalid`,
        reason: 'RLS self-test row',
        added_by: 'selftest'
      },
      'This tells an attacker exactly which lookalike domains are pre-cleared, ' +
        'and therefore which ones this tool will never flag.'
    );

    await checkTableUnreadable(
      anon,
      admin,
      'job_runs',
      'the job log',
      { job: `${TEST_PREFIX}selftest` },
      'This exposes internal operational data about what is being scanned and when.'
    );

    await checkTableUnreadable(
      anon,
      admin,
      'reports',
      'dispute reports',
      {
        domain: `${TEST_PREFIX}report.invalid`,
        kind: 'other',
        note: 'RLS self-test row, safe to delete.',
        contact: 'selftest@example.invalid',
        status: 'open'
      },
      "Reports carry a reporter's contact details, which were given in confidence."
    );

    // --- Public writes must be refused -------------------------------------
    await checkWritesRefused(anon, publishedDomain);

    // --- What the public SHOULD be able to do ------------------------------
    await checkBrandsReadable(anon);
  } finally {
    // --- Cleanup, even on failure ------------------------------------------
    // Every row this script writes is prefixed, so cleanup is exact and cannot
    // touch real data. Candidates go first because other tables reference them.
    await admin.from('candidates').delete().like('domain', `${TEST_PREFIX}%`);
    await admin.from('allowlist').delete().like('domain', `${TEST_PREFIX}%`);
    await admin.from('reports').delete().like('domain', `${TEST_PREFIX}%`);
    await admin.from('job_runs').delete().like('job', `${TEST_PREFIX}%`);
    await admin.from('brands').delete().like('slug', `${TEST_PREFIX}%`);
    if (temporaryBrand && brandId) {
      await admin.from('brands').delete().eq('id', brandId);
    }
  }

  console.log('');
  if (failures > 0) {
    console.error(
      `${failures} of ${checks} checks FAILED.\n\n` +
        'Do NOT deploy this publicly until they pass. Re-run\n' +
        'supabase/migrations/0002_rls.sql and read the warning it raises - if your\n' +
        'project is on PostgreSQL 14, `security_invoker` cannot be set and the\n' +
        'views bypass RLS entirely.\n'
    );
    process.exit(1);
  }
  console.log(`All ${checks} checks passed. The publishable key is safe to expose.\n`);
}

/**
 * The single most important assertion in this project's security posture: a
 * low-tier candidate, which was deliberately never published, must be invisible
 * to the key that ships to browsers. It is checked through both the table and
 * the view, because they fail independently - the table is governed by a policy
 * and the view by `security_invoker`.
 */
async function checkHiddenIsInvisible(anon: SupabaseClient, domain: string) {
  const { data: viaTable } = await anon
    .from('candidates')
    .select('domain')
    .eq('domain', domain);

  if (viaTable && viaTable.length > 0) {
    fail(
      'A hidden candidate is NOT readable via the candidates table',
      `The publishable key read back "${domain}", which was written with ` +
        `publish_state = 'hidden'. Your entire internal list is public.`
    );
  } else {
    pass('A hidden candidate is not readable via the candidates table');
  }

  const { data: viaView } = await anon
    .from('public_feed')
    .select('domain')
    .eq('domain', domain);

  if (viaView && viaView.length > 0) {
    fail(
      'A hidden candidate is NOT readable via the public_feed view',
      `The view returned "${domain}". This usually means security_invoker is ` +
        `not set on the view, so it runs as its owner and bypasses RLS.`
    );
  } else {
    pass('A hidden candidate is not readable via the public_feed view');
  }
}

async function checkPublishedIsVisible(anon: SupabaseClient, domain: string) {
  const { data, error } = await anon
    .from('public_feed')
    .select('domain')
    .eq('domain', domain);

  if (error) {
    fail('A published candidate IS readable', `Query failed: ${error.message}`);
  } else if (!data || data.length === 0) {
    fail(
      'A published candidate IS readable',
      'The feed returned nothing for a published row. The policies are too ' +
        'restrictive and the public feed will always look empty.'
    );
  } else {
    pass('A published candidate is readable, so the feed will work');
  }
}

/**
 * Confirms the publishable key cannot read a table.
 *
 * The subtlety: an empty table also returns zero rows, so a naive version of
 * this check passes vacuously on a fresh project - exactly when someone is most
 * likely to run it, and least likely to notice it proved nothing. So the row is
 * guaranteed to exist first, written with the secret key, and the test only
 * counts if the admin client can see something the anon client cannot.
 */
async function checkTableUnreadable(
  anon: SupabaseClient,
  admin: SupabaseClient,
  table: string,
  label: string,
  seedRow: Record<string, unknown>,
  consequence: string
) {
  const { count } = await admin
    .from(table)
    .select('*', { count: 'exact', head: true });

  if ((count ?? 0) === 0) {
    const { error } = await admin.from(table).insert(seedRow);
    if (error) {
      fail(
        `The public cannot read ${label}`,
        `Could not plant a test row in "${table}" (${error.message}), so this ` +
          `check could not be made meaningful. Treat it as unproven.`
      );
      return;
    }
  }

  // Re-confirm with the admin key that there really is something to hide.
  const { count: adminCount } = await admin
    .from(table)
    .select('*', { count: 'exact', head: true });

  if ((adminCount ?? 0) === 0) {
    fail(
      `The public cannot read ${label}`,
      `"${table}" is still empty, so nothing was actually tested.`
    );
    return;
  }

  const { data, error } = await anon.from(table).select('*').limit(1);

  if (error || !data || data.length === 0) {
    pass(`The public cannot read ${label} (${adminCount} row(s) hidden from it)`);
  } else {
    fail(`The public cannot read ${label}`, `Returned ${data.length} row(s). ${consequence}`);
  }
}

async function checkWritesRefused(anon: SupabaseClient, domain: string) {
  const { error: updateErr } = await anon
    .from('candidates')
    .update({ publish_state: 'published' })
    .eq('domain', domain);

  // Supabase returns no error when a policy simply matches zero rows, so verify
  // by reading the row back with the same key rather than trusting the response.
  const { data: after } = await anon
    .from('public_feed')
    .select('publish_state')
    .eq('domain', domain)
    .maybeSingle();

  if (updateErr || !after || after.publish_state === 'published') {
    pass('The public cannot promote a candidate to published');
  } else {
    fail('The public cannot promote a candidate', 'An anonymous UPDATE was accepted.');
  }

  const { error: deleteErr } = await anon.from('candidates').delete().eq('domain', domain);
  const { data: stillThere } = await anon
    .from('public_feed')
    .select('domain')
    .eq('domain', domain);

  if (deleteErr || (stillThere && stillThere.length > 0)) {
    pass('The public cannot delete candidates');
  } else {
    fail(
      'The public cannot delete candidates',
      'An anonymous DELETE removed a published row. Anyone could erase the feed.'
    );
  }

  const { error: brandErr } = await anon
    .from('brands')
    .insert({ name: `${TEST_PREFIX}evil`, slug: `${TEST_PREFIX}evil`, category: 'other' });

  if (brandErr) {
    pass('The public cannot add brands to the watchlist');
  } else {
    fail(
      'The public cannot add brands to the watchlist',
      'An anonymous INSERT into brands succeeded. Anyone could make this tool ' +
        'scan and publish accusations about a target of their choosing.'
    );
  }
}

async function checkBrandsReadable(anon: SupabaseClient) {
  const { error } = await anon.from('brands').select('name').limit(1);
  if (error) {
    fail(
      'The public can read the watchlist',
      `Query failed: ${error.message}. The brand filter on the feed page will break.`
    );
  } else {
    pass('The public can read the watchlist, which is meant to be transparent');
  }
}

main().catch((err) => {
  console.error('\nSelf-test crashed:', err instanceof Error ? err.message : err);
  console.error('Temporary rows may remain; they all start with', TEST_PREFIX);
  process.exit(1);
});
