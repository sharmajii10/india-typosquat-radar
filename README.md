# India Typosquat / Phishing Radar

A public, live feed of newly-issued TLS certificates on domains that appear to
impersonate Indian banks, payment apps and government portals.

It watches Certificate Transparency logs, finds names that resemble a watched
brand, then independently verifies each one before showing anything publicly.
Free to run, free to use, no accounts, no ads, nothing for sale.

---

## The one idea that shapes everything here

**Name similarity is a weak signal and is never sufficient to publish.**

`hdfcconsulting.com` looks like a bank domain and is probably a consultancy.
Publishing a list of domains on string similarity alone means publicly accusing
real businesses at scale on the basis of a spell-check. So the matcher is only
step one of five, and it is deliberately permissive, because everything after it
is strict:

```
CT logs (crt.sh)
  -> candidate matching      edit distance + Unicode confusables folding
  -> verification            DNS -> RDAP age -> passive content check
  -> risk scoring            weighted sum, every point itemised and stored
  -> confidence gating       high -> published
                             medium -> human review queue, labelled "unconfirmed"
                             low -> internal only, never public
  -> recheck loop            re-verified on a schedule, never judged once
```

Three gates sit on top of the numeric threshold, and each can only hold a
candidate back, never push it forward. To be auto-published a domain must:

1. score at or above the high threshold,
2. actually resolve,
3. have at least two independent categories of evidence, and
4. have at least one signal with no innocent reading, meaning a password field
   on the page or look-alike Unicode characters in the name.

The name weights are arranged so their maximum total sits below the publication
threshold. That is an arithmetic property, so it is asserted mechanically rather
than trusted:

```bash
npm run check:weights
```

If you retune the weights and that check fails, the tool has become capable of
publishing on a name alone. Fix the weights, do not delete the check.

---

## Local development

### 0. Install Node.js

This project needs **Node.js 20.9 or newer** (Next 16 requires it). Node 22 LTS
is the smoother choice: on Node 20 the Supabase client needs a WebSocket
polyfill, which `scripts/_bootstrap.ts` installs for you, but Node 22 has one
built in and needs nothing. Check your version with `node -v`.

If you do not have it, on Windows:

```bash
winget install OpenJS.NodeJS.LTS
```

That opens a UAC prompt and needs administrator rights. If you cannot elevate,
download the **Windows Binary (.zip)** from nodejs.org, unzip it anywhere, and
add that folder to your `PATH` - no installer and no admin rights required.

On macOS or Linux use your package manager, or nodejs.org.

### 1. Install dependencies

Already done in this checkout - `node_modules/` is populated and `npm audit`
reports no vulnerabilities. Re-run it after pulling changes:

```bash
npm install
```

### 2. Create a free Supabase project

1. Sign up at supabase.com. The free tier needs no card.
2. Create a new project. Any region works; Mumbai (`ap-south-1`) is closest to
   the data being watched.
3. Wait for it to finish provisioning, then open **Project Settings -> API
   Keys** and copy three values: the Project URL, the **Publishable key**, and
   the **Secret key**.

Supabase renamed these keys, so older guides call them something else. They are
the same two keys:

| Dashboard now shows | Previously called | Postgres role | Safe in a browser? |
| --- | --- | --- | --- |
| Publishable key (`sb_publishable_…`) | `anon` / public key | `anon` | Yes, because Row Level Security restricts it |
| Secret key (`sb_secret_…`) | `service_role` key | `service_role` | **No.** It bypasses Row Level Security entirely |

Projects created a while ago still issue JWT-shaped keys beginning with `eyJ`.
Both formats work.

### 3. Run the migrations

In the Supabase dashboard, open **SQL Editor** and run these two files in order:

1. `supabase/migrations/0001_init.sql` — tables, indexes and views
2. `supabase/migrations/0002_rls.sql` — Row Level Security policies

The second one matters more than it looks. It is what makes the anon key, which
ships to every browser, unable to read low-tier candidates even if a bug in a
route handler asks for them.

### 4. Configure environment variables

```bash
cp .env.example .env.local
```

Fill in the three Supabase values from the previous step, then generate a job
secret:

```bash
openssl rand -hex 32
```

Paste that as `JOB_SECRET`. On Windows without openssl, any long random string
of 32 or more characters works.

### 5. Seed the watchlist

```bash
npm run seed
```

This writes the fifteen seed brands and their allowlist entries. It is
idempotent, so re-run it any time you edit the watchlist.

### 6. Prove Row Level Security actually works

**Do this before you deploy anything publicly.**

```bash
npm run check:rls
```

The publishable key ships to every browser that loads the site. The only thing
stopping a visitor from reading your entire internal candidate list, and the
allowlist that shows which lookalikes are pre-cleared, is the policy set in
`0002_rls.sql`. Those policies fail silently when they are wrong: the app works,
the feed renders, and the internal list is quietly world-readable.

So this script does not read your policies, it attacks them. It writes a hidden
candidate and a published one with the secret key, then tries to read both back
with the publishable key, and asserts that only the published one comes back. It
also confirms the allowlist, job log and dispute reports are unreadable, that
anonymous writes are refused, and that the watchlist is still public. Every row
it creates is prefixed and deleted afterwards, including when a check fails.

If anything fails, do not go public until it passes. The usual cause is
`security_invoker` not being set on the views, which makes them run as their
owner and bypass RLS entirely. On PostgreSQL 14 it cannot be set at all, and the
migration raises a warning saying so.

### 7. Check the pipeline logic

Before wiring anything up, confirm the matching and scoring behave:

```bash
npm run smoke
```

This runs synthetic certificate names and verification results through the real
matcher, scorer and confidence gates. It needs no database and no network. The
cases are the ones that matter: `hdfc-consulting.com` must stay off the feed,
a live branded credential form must reach high confidence, and a punycode
homograph must be decoded before it is judged.

```bash
npm run check:weights
```

asserts the scoring invariants described at the top of this README.

### 8. Run it

```bash
npm run dev
```

Open http://localhost:3000. The feed will be empty until you ingest something.

### 9. Ingest some data

In a second terminal, with the dev server still running:

```bash
npm run job:poll -- --lookbackHours 24 --brands 15
```

That queries crt.sh for every brand, matches what comes back, and writes hidden
candidates. It takes a couple of minutes because it deliberately paces its
requests to a free community service.

Then verify and score them:

```bash
npm run job:recheck -- --limit 50
```

Refresh the page. Anything that cleared the gates is now on the feed.

To see what is waiting on human review:

```bash
npm run job:review
```

---

## Deploying

### Vercel

1. Push this repository to GitHub. Make it **public** — GitHub Actions minutes
   are only unlimited on public repositories, and the free schedule depends on
   that.
2. Import the repository at vercel.com. Accept the detected Next.js defaults.
3. Add the environment variables below under **Settings -> Environment
   Variables**, for Production and Preview.
4. Deploy. Note your `*.vercel.app` URL.

Stay on the free `*.vercel.app` subdomain. A custom domain is the one place a
real recurring cost can sneak into this project.

### Environment variable checklist

**Required.** The app will not work without these four:

| Variable | Where it goes | What it is |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel | Supabase project URL. Origin only, no path, no trailing slash |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel | The **Publishable key**. Restricted by Row Level Security. `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` also works |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel | The **Secret key**. Bypasses RLS, server-side jobs only, never prefix with `NEXT_PUBLIC_`. `SUPABASE_SECRET_KEY` also works |
| `JOB_SECRET` | Vercel **and** GitHub | Shared secret protecting `/api/jobs/*`. Must be byte-identical in both places |

**Optional.** Everything works without them:

| Variable | Where it goes | What it does |
| --- | --- | --- |
| `NEXT_PUBLIC_SITE_URL` | Vercel | Sets `metadataBase`, so social-preview and canonical links resolve against your domain instead of localhost. Add it after the first deploy, when you know the URL |
| `NEXT_PUBLIC_CONTACT_EMAIL` | Vercel | Adds an email route to the dispute page, for people who would rather not use a form on the site that just listed them |
| `REVIEW_PASSWORD` | Vercel | Password for the reviewer UI at `/review`. At least 16 characters. Falls back to `JOB_SECRET` if unset, but a separate password is better - the job secret is also stored in GitHub Actions |
| `POLL_BRANDS_PER_RUN` | Vercel | Brands per poll run. Defaults to 4 |
| `RECHECK_BATCH_SIZE` | Vercel | Candidates re-verified per run. Defaults to 25 |

### GitHub repository secrets

Under **Settings -> Secrets and variables -> Actions**, add:

| Secret | Value |
| --- | --- |
| `RADAR_BASE_URL` | `https://your-project.vercel.app`, no trailing slash |
| `JOB_SECRET` | Exactly the same value as in Vercel |

Then open the **Actions** tab and enable workflows. The `Radar` workflow starts
firing every ten minutes on its own. Trigger it once manually first to confirm
the secrets are right.

### Verify the deployment

```bash
curl -X POST -H "Authorization: Bearer $JOB_SECRET" \
  "https://your-project.vercel.app/api/jobs/poll?lookbackHours=24&brands=15"
```

A `401` means the secret does not match. A `503` means the Supabase variables
are missing.

---

## Adding a brand to the watchlist

Edit `BRAND_SEED` in [`scripts/seed.ts`](scripts/seed.ts), then run
`npm run seed`. Existing brands are updated in place, so this is also how you
push edits.

```ts
{
  name: 'Bank of Baroda',
  slug: 'bank-of-baroda',
  category: 'bank',                 // bank | payment | government | other
  officialDomains: [
    'bankofbaroda.in',
    'bankofbaroda.co.in',
    'bobibanking.com'
  ],
  aliases: ['bob', 'bankofbaroda', 'bobibanking'],
  extraTerms: ['bobworld'],         // how people actually type it
  excludeTerms: ['bob']             // too short and too common to match on
}
```

**Choosing match terms is the single highest-leverage false-positive control in
this project — more so than any scoring weight.** Three rules:

- **Prefer specific over short.** `bankofbaroda` and `bobibanking` are good
  terms. `bob` is a name, a word, and three characters; it would match thousands
  of unrelated domains and bury everything real. Put terms like that in
  `excludeTerms`.
- **Never add an ordinary English or Hindi word.** `axis` is excluded from Axis
  Bank for exactly this reason.
- **Watch what gets derived automatically.** Terms are generated from the brand
  name and from the registrable label of each official domain. Google Pay's
  official domain is `pay.google.com`, whose label is `google` — which would flag
  every Google-adjacent domain on the internet. That is why `excludeTerms`
  exists. The seed script prints the final term list for each brand, so read the
  output.

Term length changes behaviour, by design:

| Term length | Matching behaviour |
| --- | --- |
| Under 3 | Dropped entirely |
| 3 to 4 | Whole-word matches only (`upi-verify.com` matches, `occupied.com` does not) |
| 5 or more | Also matches inside longer words |
| 6 or more | Also matches fuzzily, within 2 edits |

Add the brand's subsidiaries and campaign domains to `ALLOWLIST_SEED` in the same
file. Allowlisted domains are excluded at the very top of the pipeline and can
never be flagged.

---

## Tuning the risk weights

Every weight lives in [`lib/scoring/weights.ts`](lib/scoring/weights.ts), and
every one carries a comment explaining why it is that size. The current values
are reasoned starting estimates, **not** values fitted to data — they will be
wrong in detail and are meant to be tuned.

To tune them properly:

1. Get labelled data. PhishTank and OpenPhish publish confirmed-phishing feeds;
   the Tranco list is a clean negative set.
2. Run both through the pipeline's real verification output.
3. Move the thresholds in [`lib/config.ts`](lib/config.ts) to whatever gives an
   acceptable false-positive rate.
4. Re-run `npm run check:weights`.

For a tool that publishes accusations, precision matters far more than recall. A
missed phishing site is one this project was never going to be alone in catching.
A wrongly published legitimate business is a real harm to a real person.

Every score is stored with its full itemised evidence in
`risk_scores.contributing_signals`, so retuning can be back-tested against
everything the pipeline has ever seen.

---

## The review queue

Medium-tier candidates never auto-publish. They wait at **`/review`** for a
person, and appear on the public feed only as "unconfirmed" until decided.

Sign in with `REVIEW_PASSWORD`. Each item shows everything needed to decide
without opening another tab: the itemised evidence that produced the score, what
argued against it, the facts behind it, and any dispute somebody has filed.
Disputed items sort to the top, because someone actively saying a listing is
wrong about them is the most urgent thing in the queue.

Three decisions:

| Button | Effect |
| --- | --- |
| **Publish** | Goes on the public feed as a high-confidence detection |
| **Not a threat** | Permanently allowlisted, so no future scan can flag it again, and any dispute about it is resolved. Requires a reason |
| **Keep hidden** | Off the feed, still tracked and re-checked. Right for something suspicious that is not yet live |

Clearing is styled as the safe, easy path and publishing as the consequential
one. That asymmetry is deliberate: publishing a wrong accusation harms a real
business, whereas missing a real phishing site costs a detection this project
was never going to be alone in making.

The same decisions are available over curl for scripting, at
`/api/jobs/review`, behind `JOB_SECRET`. Both call the same
`applyReviewDecision`, so they cannot drift - and the step that would drift is
the allowlist write, which is what makes a correction permanent.

---

## Known limitation: GitHub does not honour the schedule

`radar.yml` asks for a run every 10 minutes. **GitHub delivers roughly one every
two hours.** Measured over 20 consecutive scheduled runs on this repository, the
gaps ranged from 97 to 310 minutes, with a median near 120.

This is documented GitHub behaviour rather than a fault: scheduled workflows are
best-effort, are delayed during periods of high load, and are dropped outright
when the runner pool is busy. High-frequency crons on free public repositories
are throttled hardest. Lowering the cron interval does not help, and may make it
worse.

What this means in practice:

- **Detection latency is hours, not minutes.** Any claim that this is a
  real-time radar should be read with that in mind.
- **Nothing is missed.** The poll asks for a six-hour lookback window rather than
  tracking a cursor, so a two-hour gap is covered several times over. Slower, not
  lossy.
- **A full brand sweep takes longer.** At 4 brands per run and 15 brands, one
  complete rotation now takes most of a day rather than 40 minutes.

If genuine minute-level latency ever matters, the fix is not a different cron.
It is a long-running process consuming CT logs directly, which is the same change
that would remove the crt.sh dependency below.

---

## Reading CT logs directly

The primary source is now the Certificate Transparency logs themselves, read
over RFC 6962, rather than crt.sh.

```bash
npm run ct:scan -- --dry-run --minutes 3 --logs 3
```

**Why.** crt.sh is one third-party web front-end. It returns 502s for hours and,
worse, answers HTTP 200 with an empty array while degraded - a failure that
looks exactly like a healthy run finding nothing. The logs it reads are operated
by Google, Cloudflare, DigiCert and Let's Encrypt and are covered by Chrome's
uptime requirements. Reading them removes the outage dependency and cuts latency
from "whenever a poll fires" to seconds after issuance.

**How it works.** `scripts/ct-scan.ts` runs in GitHub Actions, not on Vercel - a
walk through millions of entries does not fit in a 60-second function, which is
the ceiling that broke the crt.sh poller once already. It reads Chrome's log
list, picks the least-recently-scanned logs spread across operators, walks
forward from a stored cursor, and posts anything interesting to
`/api/jobs/ingest`. It talks to the API rather than the database so the Supabase
secret key never has to exist in GitHub.

**The pre-filter is the load-bearing piece.** The logs carry millions of
certificates a day, so names are filtered where they are read.
`lib/ct/filter.ts` must be a permissive *superset* of `lib/matching/match.ts`:
anything the matcher would flag has to survive, because whatever the filter
drops is never seen again by anything. Being wrong permissively costs one HTTP
round trip; being wrong strictly is a silent, permanent miss. `npm run smoke`
asserts that contract.

Measured against live logs, it passes **0.033%** of entries. An earlier version
passed 0.72% - twenty-one times more - because it matched short terms as
substrings (`sbi` inside `joshnesbitt.co.uk`) and waved every punycode name
through instead of decoding it.

**Falling behind.** If the cursor drops more than `--max-lag` entries behind the
head, the scanner jumps forward and records the skip. A live radar reading
yesterday's certificates is worse than useless: it looks healthy while reporting
stale results and never catches up.

`supabase/migrations/0003_ct_logs.sql` stores the per-log cursor. Without it the
scanner still runs, but restarts from each log's head every time and says so.

---

## Known operational risk: crt.sh availability

**crt.sh is unreliable, and it is the only data source.** This is the biggest
practical risk to the project working, so it is stated here rather than buried.

During development, crt.sh returned HTTP 502 for every query across four
different URL shapes for an extended period, then partially recovered. It is a
free community service run by Sectigo with no uptime obligation to anyone, and
building on it means accepting that.

### The dangerous failure mode: HTTP 200 with an empty array

crt.sh does not only return 502s. While degraded it also answers a perfectly
valid `200 OK` with a two-byte body: `[]`.

That is worse than an error, and it was observed during development. A wildcard
query for `hdfcbank`, a term with thousands of historical certificates, returned
zero rows with no error at all. Naive retry logic sees valid JSON and calls it
success. The job reports `ok: true, sightings: 0`, no failures are recorded, and
the feed silently never fills. You would deploy this, watch an empty page for a
week, and have nothing anywhere telling you why.

So the poll distinguishes two outcomes that look identical from the outside:

| What happened | Meaning |
| --- | --- |
| Rows returned, none recent | Normal. crt.sh answered, nothing new in the window |
| Zero rows returned at all | Not a real answer for a broad brand term |

The second case is retried once, then recorded in `job_runs.stats` as
`emptyTerms`. If **every** term in a run comes back that way, the run sets
`upstreamLooksDegraded: true` and attaches a plain-English `warning`. Check
`job_runs` when the feed stops growing.

### What the code does about crt.sh generally

- **Retries** each query up to three times with backoff. This measurably
  converts transient 502s into successes.
- **Isolates failures per term.** One dead query does not sink a run; the
  failure is recorded in `job_runs.stats` and the next brand is polled.
- **Uses an overlapping lookback window**, not a cursor. The poll asks for the
  last six hours every ten minutes, so an entirely failed run loses nothing
  that the next run will not pick up.

Check `job_runs` for a run's `failures` array if the feed stops growing.

If outages become sustained rather than intermittent, the free options are, in
order of effort:

1. **crt.sh's public PostgreSQL interface** (`crt.sh:5432`, database
   `certwatch`, user `guest`). Same data, no key, and it frequently answers
   while the web front-end is down, because the 502s are usually in the web
   tier. Needs a Postgres client dependency.
2. **Reading CT logs directly** from the log operators. Free and keyless, but
   it is the whole firehose, so you filter locally. That needs a long-running
   process rather than a serverless function, which fits the same GitHub
   Actions shape as the certstream upgrade in Phase 2.

Do not solve this by buying a commercial CT feed. The zero-cost constraint is
the point.

---

## What has been verified

Everything below was actually run, not assumed:

| Check | Result |
| --- | --- |
| `npm run typecheck` | Clean |
| `npm run build` | Succeeds |
| `npm run check:weights` | 9 invariants hold |
| `npm run smoke` | 14 pipeline cases, 6 parsing checks |
| `npm audit` | 0 vulnerabilities |
| `npm run seed` | Reaches the network on Node 20 with either key naming |
| `npm run check:rls` | 10 checks, all passing against a live Supabase project |
| `npm run seed` | 15 brands and 21 allowlist entries written to a live project |
| Live poll run | Ran against crt.sh; ingest, dedupe and outage detection all exercised |
| Public API | `/api/brands`, `/api/stats`, `/api/feed` all serving correctly |
| DNS verification | Live, against real domains including `.co.in` |
| RDAP verification | Live, returns registrar and creation date for `.com` and `.co.in` |
| Job route authentication | Rejects missing and wrong secrets with 401 |
| Pages render | Feed, methodology and dispute pages all load |
| crt.sh | Retry logic exercised against the live service during an outage |

Row Level Security has since been verified against a live Supabase project:
all 10 checks in `npm run check:rls` pass, including the one that matters most,
where a deliberately hidden candidate is planted and then proves unreadable
through both the table and the view.

Four bugs were found this way, every one of which would have been invisible in
production:

- **Punycode homographs were never detected.** Certificate Transparency records
  IDN domains in punycode, so `päytm.com` arrives as `xn--pytm-loa` — pure
  ASCII, with the substituted character encoded away. The matcher folded that
  string, found nothing, and moved on. The single strongest name signal in the
  model would never once have fired. The matcher now decodes before folding, and
  the smoke test locks it in.
- **DNS lookups silently returned empty results.** Four concurrent queries
  through one resolver returned no MX and no NS records for domains that
  demonstrably have both. An empty answer is indistinguishable from a genuine
  absence, so this quietly dropped a real scoring signal with no error anywhere.
  The lookups are now sequential.
- **`npm run seed` failed outright on Node 20.** The Supabase client eagerly
  builds a Realtime client, which needs a global `WebSocket`. Node 22 has one,
  Node 20 does not, so `createClient()` threw before a single query ran. The web
  app was unaffected because the Next.js server runtime provides its own
  `WebSocket` - so this broke only the very first command in the setup guide,
  and only on one Node version. `scripts/_bootstrap.ts` now polyfills it.
- **A degraded crt.sh looked like a healthy empty run.** See the section above.
  The pipeline would have reported success forever while ingesting nothing.

The parts that could not be verified here, because they need credentials this
environment does not have:

- A live Vercel deployment and the GitHub Actions schedule.
- A full end-to-end detection, because crt.sh was degraded throughout testing.
  Every stage was exercised individually and the matching and scoring stages are
  covered by `npm run smoke`, but no real lookalike domain has yet travelled the
  whole path from certificate log to published feed item.

---

## Guardrails

These are requirements, not preferences.

- **Passive only.** One GET request per domain per verification pass. No
  crawling, no port scanning, no login attempts, no form submission, no
  credential entry of any kind. Hard timeouts and byte caps.
- **Honest identification.** The scanner sends a descriptive User-Agent with a
  contact URL, so anyone reading their server logs can see what hit them and ask
  us to stop. Set it in `SCANNER_USER_AGENT` in `lib/config.ts` before deploying.
- **No fetching private address space.** The content checker refuses any domain
  resolving to a private, loopback or link-local address, so the deployed
  function cannot be used to reach internal infrastructure.
- **The allowlist runs first.** Before matching, before scoring, before anything.
- **Confidence-matched language.** Nothing below high tier is ever stated as a
  finding. The strongest phrasing used anywhere is "high confidence" — never
  "confirmed phishing", never "malicious". The pipeline observes behaviour; it
  does not adjudicate intent.
- **Domains are never linked.** Suspected credential-harvesting pages appear as
  plain text, never as clickable links.
- **The dispute path was built in the first pass**, not bolted on. A cleared
  domain is added to the allowlist permanently and cannot be re-flagged by a
  later scan.

---

## Cost model

Everything here is free with no card, no trial, and no expiry.

| Component | Service | Why it stays free |
| --- | --- | --- |
| Hosting | Vercel Hobby | Free indefinitely for personal, non-commercial use. Keep it non-commercial: no ads, no sponsors, no donation button that starts looking like a business |
| Database | Supabase free tier | Free indefinitely. Pauses after 7 days of database inactivity, which the 10-minute job schedule prevents |
| Scheduling | GitHub Actions | Free and unmetered on public repositories. 5-minute floor; this asks for 10, and GitHub delivers roughly every 2 hours - see below |
| CT logs | crt.sh | Free public service, no key |
| Registration data | RDAP | Free, served directly by registries, no key |
| DNS | Public resolvers | Free |

Two free-tier traps, both already handled:

- **Vercel Cron is not usable here.** On Hobby it is capped at one run per day,
  and that run only fires somewhere within its scheduled hour. That is why the
  schedule lives in GitHub Actions and Vercel only hosts the endpoints.
- **GitHub disables scheduled workflows** in a public repo after 60 days with no
  commits — a different clock from how often the workflow fires. The
  `Heartbeat` workflow commits a timestamp three times a month to reset it.

Do not substitute a paid domain-monitoring API, WHOIS service or CT streaming
provider. The zero-cost constraint is a design requirement, not a placeholder.

---

## Project layout

Built on Next.js 16 (App Router) and React 19, so route `params` and
`searchParams` arrive as promises and must be awaited.

| Path | What lives there |
| --- | --- |
| `lib/config.ts` | Every threshold and tunable. Bare numbers elsewhere are bugs |
| `lib/scoring/weights.ts` | Scoring weights, each with its rationale |
| `lib/scoring/score.ts` | The weighted sum and the confidence gates |
| `lib/matching/` | Confusables folding, edit distance, keyword detection, the matcher |
| `lib/verify/` | DNS, RDAP, passive content check, ASN stub |
| `lib/ct/crtsh.ts` | The Certificate Transparency source |
| `lib/pipeline/` | Ingest and assess — the only writers of `publish_state` |
| `app/api/jobs/` | Secured endpoints the GitHub workflow calls |
| `app/api/` | Public read API: feed, brands, stats, candidate detail, report, health |
| `app/review/` | The human review queue UI, behind a password |
| `lib/pipeline/review.ts` | The review decision, shared by the UI and the curl endpoint |
| `supabase/migrations/` | Schema and Row Level Security |
| `scripts/` | Seed, job runner, weights invariant check, pipeline smoke test, RLS self-test |

---

## Phase 2, deliberately out of scope for now

- **Real-time CT streaming.** A certstream-style websocket feed removes polling
  latency and the per-brand query fan-out. It needs a long-lived process, which
  does not fit serverless — the free-tier-compatible shape is a GitHub Actions
  step that listens for a bounded window, batches, POSTs, and exits. Noted in
  `lib/ct/crtsh.ts`.
- **Visual fingerprinting.** Screenshot each candidate and perceptually hash it
  against the real login page. Run headless Chromium inside the Actions runner
  rather than as a hosted service, so it stays free.
- **ASN reputation.** Currently a stub that records the IP and scores zero.
  `lib/verify/asn.ts` explains why every available source is either paid,
  licence-restricted, or stale enough to mostly penalise small Indian hosting
  providers — which is the exact false-positive this project cannot afford.
- **Real reviewer accounts.** The reviewer UI is behind a single shared
  password, which cannot tell you who cleared a domain. Fine for one operator;
  replace it with real accounts before a second person reviews.

---

## Licence and intent

This is a non-commercial public-interest tool. Listings describe what an
automated scan observed. They are evidence, not verdicts, and never statements
about anyone's intent. If a listing is wrong, the dispute form is on every page
and the correction is permanent.
