/**
 * Re-run the matcher over everything already in the queue and retire whatever
 * no longer matches.
 *
 *   npm run prune              # report only, writes nothing
 *   npm run prune -- --apply   # actually hide the stale rows
 *
 * WHY THIS EXISTS
 * ---------------
 * Match terms get corrected. When they do, the candidates the old terms
 * produced stay exactly where they were - a queue full of domains the pipeline
 * would no longer flag if it saw them today, waiting on a human to work out
 * that they are stale. That is the worst kind of review burden: the reviewer
 * cannot tell, from the row alone, whether it is a real judgement call or the
 * residue of a term that has since been dropped.
 *
 * Dropping the term and leaving the queue is a half-finished fix, so this is
 * the other half. Fixing `kotak` (Indonesian for "box") removed nine rows;
 * `imobile`, one edit from `mobile`, removed seven more.
 *
 * WHY IT HIDES RATHER THAN CLEARS
 * -------------------------------
 * `clear` writes an allowlist row, which is permanent and means "a person
 * looked at this and it is legitimate". Nobody looked. All this knows is that
 * the current rules no longer produce a match, which is a statement about our
 * terms and not about the domain. `hide` takes it off the public feed and out
 * of the queue while leaving it re-flaggable if the rules change again.
 */

import './_bootstrap';

import { config } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { matchCertName } from '../lib/matching/match';
import { SUPABASE_SECRET_KEYS, SUPABASE_URL_KEYS, readEnv } from '../lib/env';
import type { Brand } from '../lib/types';

config({ path: '.env.local' });
config({ path: '.env' });

/** States worth re-checking. A cleared or already-hidden row is settled. */
const LIVE_STATES = ['published', 'pending_review'];

async function main() {
  const apply = process.argv.includes('--apply');

  const url = readEnv(SUPABASE_URL_KEYS);
  const secret = readEnv(SUPABASE_SECRET_KEYS);
  if (!url || !secret) {
    console.error('Supabase URL and secret key must be set in .env.local.');
    process.exit(1);
  }

  const db: SupabaseClient = createClient(url, secret, { auth: { persistSession: false } });

  const { data: brands, error: brandErr } = await db.from('brands').select('*').eq('active', true);
  if (brandErr || !brands) throw new Error(`could not read brands: ${brandErr?.message}`);

  const { data: allowRows } = await db.from('allowlist').select('domain');
  const allowlist = new Set<string>((allowRows ?? []).map((r) => String(r.domain).toLowerCase()));
  for (const b of brands) {
    for (const d of (b.official_domains ?? []) as string[]) allowlist.add(d.toLowerCase().trim());
  }

  const { data: candidates, error: candErr } = await db
    .from('candidates')
    .select('id, domain, publish_state, matched_term')
    .in('publish_state', LIVE_STATES)
    .order('first_seen_at', { ascending: false });
  if (candErr || !candidates) throw new Error(`could not read candidates: ${candErr?.message}`);

  console.log(
    `${candidates.length} live candidate(s), ${brands.length} active brand(s)` +
      `${apply ? '' : '  (dry run - nothing will be written)'}\n`
  );

  const stale: Array<{ id: string; domain: string; state: string; wasTerm: string }> = [];
  const kept: Array<{ domain: string; term: string; kind: string }> = [];

  for (const c of candidates) {
    const match = matchCertName({
      name: c.domain as string,
      brands: brands as unknown as Brand[],
      allowlist
    });

    if (match) {
      kept.push({
        domain: c.domain as string,
        term: match.matchedTerm,
        kind: match.matchKind
      });
    } else {
      stale.push({
        id: c.id as string,
        domain: c.domain as string,
        state: c.publish_state as string,
        wasTerm: (c.matched_term as string) ?? '?'
      });
    }
  }

  if (stale.length > 0) {
    console.log(`No longer matches the current terms (${stale.length}):`);
    for (const s of stale) {
      console.log(`  ${s.domain.padEnd(38)} was "${s.wasTerm}"  [${s.state}]`);
    }
  } else {
    console.log('Nothing stale - every live candidate still matches.');
  }

  if (apply && stale.length > 0) {
    // Done one at a time so a single failure cannot take the batch with it, and
    // so the note records why this row went away.
    let hidden = 0;
    for (const s of stale) {
      const { error } = await db
        .from('candidates')
        .update({
          publish_state: 'hidden',
          reviewed_at: new Date().toISOString(),
          reviewed_note:
            `Retired by prune-queue: matched on "${s.wasTerm}", which the current ` +
            `match terms no longer produce. Not a judgement about the domain.`
        })
        .eq('id', s.id);
      if (error) console.error(`  FAILED ${s.domain}: ${error.message}`);
      else hidden++;
    }
    console.log(`\n${hidden} of ${stale.length} hidden.`);
  } else if (stale.length > 0) {
    console.log('\nRe-run with --apply to hide these.');
  }

  console.log(`\nStill matching (${kept.length}):`);
  for (const k of kept) {
    console.log(`  ${k.domain.padEnd(38)} "${k.term}" (${k.kind})`);
  }
}

main().catch((err) => {
  console.error('\nPrune failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
