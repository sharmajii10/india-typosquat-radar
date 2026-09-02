/**
 * Trigger a job route locally, the same way GitHub Actions triggers it in
 * production. Saves hand-assembling a curl command with the right header.
 *
 *   npm run job:poll
 *   npm run job:recheck
 *   npx tsx scripts/run-job.ts poll --lookbackHours 24 --brands 15
 *
 * Requires the dev server to be running (`npm run dev`) and JOB_SECRET to be set
 * in .env.local.
 */

import { config } from 'dotenv';

config({ path: '.env.local' });
config({ path: '.env' });

const JOBS = ['poll', 'recheck', 'review'] as const;
type Job = (typeof JOBS)[number];

async function main() {
  const [, , jobArg, ...rest] = process.argv;

  if (!jobArg || !JOBS.includes(jobArg as Job)) {
    console.error(`Usage: tsx scripts/run-job.ts <${JOBS.join('|')}> [--key value ...]`);
    process.exit(1);
  }

  const secret = process.env.JOB_SECRET;
  if (!secret) {
    console.error('JOB_SECRET is not set. Add it to .env.local (any long random string).');
    process.exit(1);
  }

  const base = process.env.JOB_TARGET_URL ?? 'http://localhost:3000';

  const params = new URLSearchParams();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, '');
    const value = rest[i + 1];
    if (key && value) params.set(key, value);
  }

  const qs = params.toString();
  const url = `${base}/api/jobs/${jobArg}${qs ? `?${qs}` : ''}`;

  console.log(`POST ${url}`);
  const started = Date.now();

  const res = await fetch(url, {
    method: jobArg === 'review' ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${secret}` }
  });

  const text = await res.text();
  console.log(`HTTP ${res.status} in ${Date.now() - started}ms\n`);

  try {
    console.dir(JSON.parse(text), { depth: 6, colors: true });
  } catch {
    console.log(text);
  }

  if (!res.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
