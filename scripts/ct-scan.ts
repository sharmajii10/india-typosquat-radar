/**
 * Read Certificate Transparency logs directly and post anything interesting
 * back to the radar.
 *
 *   npm run ct:scan                       # against JOB_TARGET_URL or localhost
 *   npm run ct:scan -- --minutes 20       # scan for longer
 *   npm run ct:scan -- --logs 6           # cover more logs
 *   npm run ct:scan -- --dry-run          # read and report, post nothing
 *
 * WHY THIS RUNS IN GITHUB ACTIONS RATHER THAN ON VERCEL
 * ----------------------------------------------------
 * Reading a CT log is a long, steady walk through millions of entries. A Vercel
 * function is killed at 60 seconds, which is the constraint that already broke
 * the crt.sh poller once. A GitHub Actions job can run for hours on a public
 * repository at no cost, which fits the shape of the work.
 *
 * It talks to the radar over the authenticated job API rather than to the
 * database directly, so the Supabase secret key never has to exist in GitHub.
 *
 * WHAT IT REPLACES
 * ----------------
 * crt.sh polling. crt.sh is one web front-end that has been returning 502s for
 * hours at a time and, worse, answers HTTP 200 with an empty array while broken.
 * The logs it reads are operated by Google, Cloudflare, DigiCert and Let's
 * Encrypt and are covered by Chrome's uptime requirements. Reading them removes
 * both the outage dependency and the polling latency: entries arrive seconds
 * after issuance rather than whenever a scheduled poll happens to fire.
 */

import './_bootstrap';

import { config } from 'dotenv';
import { fetchUsableLogs, spreadAcrossOperators, type CtLogInfo } from '../lib/ct/logs';
import { scanLog } from '../lib/ct/stream';
import { buildInterestFilter } from '../lib/ct/filter';

config({ path: '.env.local' });
config({ path: '.env' });

interface Args {
  minutes: number;
  logs: number;
  maxEntriesPerLog: number;
  maxLag: number;
  dryRun: boolean;
  base: string;
  secret: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(`--${flag}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  return {
    minutes: Number(get('minutes') ?? 10),
    logs: Number(get('logs') ?? 4),
    maxEntriesPerLog: Number(get('max-entries') ?? 400_000),
    maxLag: Number(get('max-lag') ?? 300_000),
    dryRun: argv.includes('--dry-run'),
    base: (get('base') ?? process.env.JOB_TARGET_URL ?? 'http://localhost:3000').replace(
      /\/$/,
      ''
    ),
    secret: process.env.JOB_SECRET ?? ''
  };
}

async function main() {
  const args = parseArgs();

  if (!args.secret && !args.dryRun) {
    console.error('JOB_SECRET is not set. Add it to .env.local, or pass --dry-run.');
    process.exit(1);
  }

  console.log(`Target: ${args.base}${args.dryRun ? '  (dry run, nothing will be posted)' : ''}`);
  console.log(`Budget: ${args.minutes} minute(s) across up to ${args.logs} log(s)\n`);

  // --- What are we looking for, and where did we get to? -------------------
  const state = await getState(args);
  if (state.warning) console.log(`  WARNING: ${state.warning}\n`);
  if (state.terms.length === 0) {
    console.error('No watchlist terms. Run `npm run seed` first.');
    process.exit(1);
  }
  console.log(
    `Watchlist: ${state.brandCount} brands, ${state.terms.length} match terms\n`
  );

  const isInteresting = buildInterestFilter(state.terms);

  // --- Which logs to read --------------------------------------------------
  const available = await fetchUsableLogs();
  console.log(`${available.length} usable CT logs published by Chrome's log list`);

  const cursorFor = new Map(state.logs.map((l) => [l.url, l]));

  // Least-recently-scanned first, so coverage rotates rather than one log
  // absorbing every run. Logs never scanned sort first.
  const ranked = [...available].sort((a, b) => {
    const at = cursorFor.get(a.url)?.last_scanned_at;
    const bt = cursorFor.get(b.url)?.last_scanned_at;
    if (!at && !bt) return 0;
    if (!at) return -1;
    if (!bt) return 1;
    return Date.parse(at) - Date.parse(bt);
  });

  const chosen = spreadAcrossOperators(ranked, args.logs);
  const deadlineAt = Date.now() + args.minutes * 60_000;
  const perLogBudget = Math.floor((deadlineAt - Date.now()) / Math.max(1, chosen.length));

  let totalEntries = 0;
  let totalSightings = 0;
  let totalUnparsed = 0;
  let totalSkipped = 0;

  for (const log of chosen) {
    if (Date.now() >= deadlineAt) {
      console.log('\nOut of time before reaching every log; the next run continues.');
      break;
    }

    const cursor = cursorFor.get(log.url);
    const fromIndex = Number(cursor?.last_index ?? 0);
    const logDeadline = Math.min(deadlineAt, Date.now() + perLogBudget);

    process.stdout.write(`\n${log.description}\n  ${log.url}\n`);
    process.stdout.write(
      `  from index ${fromIndex.toLocaleString()}${fromIndex === 0 ? ' (cold start, will begin near the head)' : ''}\n`
    );

    const started = Date.now();
    const result = await scanLog({
      logUrl: log.url,
      fromIndex,
      deadlineAt: logDeadline,
      maxEntries: args.maxEntriesPerLog,
      maxLag: args.maxLag,
      isInteresting
    });

    if (result.entriesSkipped > 0) {
      console.log(
        `  SKIPPED ${result.entriesSkipped.toLocaleString()} entries: the cursor was more than ` +
          `${args.maxLag.toLocaleString()} behind, so it jumped to the head rather than ` +
          `keep reading stale certificates.`
      );
    }
    const behind = Math.max(0, result.treeSize - result.nextIndex);
    console.log(
      `  read ${result.entriesRead.toLocaleString()} entries in ${((Date.now() - started) / 1000).toFixed(1)}s` +
        `, ${result.sightings.length} interesting, ${result.entriesUnparsed} unparsed`
    );
    console.log(
      `  stopped: ${result.stoppedBecause}${result.error ? ` (${result.error})` : ''}` +
        `, ${behind.toLocaleString()} entries behind the head`
    );

    for (const s of result.sightings.slice(0, 8)) console.log(`    -> ${s.name}`);
    if (result.sightings.length > 8) {
      console.log(`    ... and ${result.sightings.length - 8} more`);
    }

    totalEntries += result.entriesRead;
    totalSightings += result.sightings.length;
    totalUnparsed += result.entriesUnparsed;
    totalSkipped += result.entriesSkipped;

    // Post even when nothing was found: the cursor advance is the point, and
    // losing it means re-reading the same entries forever.
    if (!args.dryRun && result.entriesRead > 0) {
      await postBatch(args, log, result);
    }
  }

  console.log('\n---');
  console.log(`Entries read : ${totalEntries.toLocaleString()}`);
  console.log(`Unparsed     : ${totalUnparsed.toLocaleString()}`);
  if (totalSkipped > 0) {
    console.log(`Skipped      : ${totalSkipped.toLocaleString()} (fell behind; jumped to the head)`);
  }
  console.log(`Interesting  : ${totalSightings.toLocaleString()}`);
  if (totalEntries > 0) {
    const rate = ((totalSightings / totalEntries) * 100).toFixed(4);
    console.log(`Hit rate     : ${rate}% of entries matched the watchlist`);
  }
}

interface StateResponse {
  logs: Array<{ url: string; last_index: number; last_scanned_at: string | null }>;
  terms: string[];
  brandCount: number;
  warning?: string;
}

async function getState(args: Args): Promise<StateResponse> {
  if (args.dryRun && !args.secret) {
    // Dry runs without a deployment still need something to filter on.
    const res = await fetch(`${args.base}/api/brands`);
    if (!res.ok) throw new Error(`could not read the watchlist: HTTP ${res.status}`);
    const body = (await res.json()) as { brands?: Array<{ aliases: string[]; name: string }> };
    const terms = [
      ...new Set((body.brands ?? []).flatMap((b) => [...b.aliases, b.name.toLowerCase()]))
    ];
    return { logs: [], terms, brandCount: body.brands?.length ?? 0 };
  }

  const res = await fetch(`${args.base}/api/jobs/ingest`, {
    headers: { authorization: `Bearer ${args.secret}` }
  });
  if (!res.ok) {
    throw new Error(`could not read scanner state: HTTP ${res.status}`);
  }
  return (await res.json()) as StateResponse;
}

async function postBatch(
  args: Args,
  log: CtLogInfo,
  result: Awaited<ReturnType<typeof scanLog>>
): Promise<void> {
  const res = await fetch(`${args.base}/api/jobs/ingest`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.secret}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      log: {
        url: log.url,
        description: log.description,
        operator: log.operator,
        treeSize: result.treeSize
      },
      nextIndex: result.nextIndex,
      entriesRead: result.entriesRead,
      error: result.error ?? null,
      sightings: result.sightings
    })
  });

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    console.error(`  POST failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    return;
  }

  const stats = (body.stats ?? {}) as Record<string, unknown>;
  console.log(
    `  posted: ${stats.matched ?? 0} matched the watchlist, ${stats.inserted ?? 0} new candidate(s)`
  );
}

main().catch((err) => {
  console.error('\nScan failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
