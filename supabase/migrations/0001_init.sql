-- ===========================================================================
-- India Typosquat / Phishing Radar - core schema
-- Run in Supabase -> SQL Editor, or via `supabase db push`.
-- ===========================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- brands: the watchlist. official_domains feeds both the matching patterns
-- and the implicit allowlist (a brand's own domain can never be a candidate).
-- aliases are extra strings worth matching on that are not domains
-- (e.g. "onlinesbi", "netbanking", "bhim").
-- ---------------------------------------------------------------------------
create table if not exists brands (
  id                uuid primary key default gen_random_uuid(),
  name              text not null unique,
  slug              text not null unique,
  category          text not null default 'bank'
                      check (category in ('bank','payment','government','other')),
  official_domains  text[] not null default '{}',
  aliases           text[] not null default '{}',
  -- Match terms are the normalised tokens we actually search crt.sh for and
  -- run edit-distance against. Derived from name/domains/aliases at seed time,
  -- stored explicitly so operators can tune noisy terms without code changes.
  match_terms       text[] not null default '{}',
  active            boolean not null default true,
  -- Round-robin cursor: the poll job picks the least-recently-polled brands.
  last_polled_at    timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists brands_active_polled_idx
  on brands (active, last_polled_at nulls first);

-- ---------------------------------------------------------------------------
-- candidates: one row per domain seen in CT that matched a watchlist term.
-- A domain is stored once; repeat certificate sightings update the cert
-- columns and bump times_seen rather than creating duplicate rows.
-- ---------------------------------------------------------------------------
create table if not exists candidates (
  id                uuid primary key default gen_random_uuid(),
  domain            text not null unique,
  unicode_domain    text,
  matched_brand_id  uuid not null references brands(id) on delete cascade,
  matched_term      text not null,
  match_kind        text not null
                      check (match_kind in ('exact_token','edit_distance','homoglyph','substring','keyword_combo')),
  edit_distance     integer not null default 0,
  homoglyph_flag    boolean not null default false,
  homoglyph_detail  jsonb,
  cert_issuer       text,
  cert_issued_at    timestamptz,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  times_seen        integer not null default 1,

  -- Lifecycle. retired = repeatedly dead, stop rechecking.
  status            text not null default 'new'
                      check (status in ('new','verified','retired')),

  -- Publication gate. Set by the scoring/gating step, never by the matcher.
  --   hidden         -> low tier, internal only, NEVER served publicly
  --   pending_review -> medium tier, awaits human review
  --   published      -> high tier, on the public feed
  --   cleared        -> a human decided it is legitimate; permanently suppressed
  publish_state     text not null default 'hidden'
                      check (publish_state in ('hidden','pending_review','published','cleared')),
  reviewed_at       timestamptz,
  reviewed_note     text,

  next_recheck_at   timestamptz not null default now(),
  recheck_count     integer not null default 0,
  created_at        timestamptz not null default now()
);

create index if not exists candidates_brand_idx      on candidates (matched_brand_id);
create index if not exists candidates_publish_idx    on candidates (publish_state, first_seen_at desc);
create index if not exists candidates_first_seen_idx on candidates (first_seen_at desc);
create index if not exists candidates_recheck_idx    on candidates (next_recheck_at)
  where status <> 'retired';

-- ---------------------------------------------------------------------------
-- verifications: append-only. One row per verification pass, so the full
-- history of how a domain behaved is kept. A domain that moves from "does not
-- resolve" to "login page with a password field" is exactly what we want to
-- catch, and that is only visible across passes.
-- ---------------------------------------------------------------------------
create table if not exists verifications (
  id                   uuid primary key default gen_random_uuid(),
  candidate_id         uuid not null references candidates(id) on delete cascade,
  checked_at           timestamptz not null default now(),

  -- Signal 1: does it resolve at all
  resolves             boolean not null default false,
  a_records            text[] not null default '{}',
  has_mx               boolean not null default false,
  ns_records           text[] not null default '{}',

  -- Signal 2: registration age (RDAP, WHOIS fallback)
  registrar            text,
  domain_created_at    timestamptz,
  domain_age_days      integer,
  rdap_status          text[] not null default '{}',
  rdap_ok              boolean not null default false,

  -- Signal 3: passive content check (single GET, no interaction)
  http_status          integer,
  final_url            text,
  page_title           text,
  has_password_field   boolean not null default false,
  brand_terms_on_page  text[] not null default '{}',
  form_posts_offsite   boolean not null default false,
  looks_parked         boolean not null default false,
  content_risk_score   integer not null default 0,
  content_error        text,

  -- Signal 5: hosting. Placeholder for MVP; see lib/verify/asn.ts.
  ip_address           text,
  asn                  text,
  asn_org              text,
  asn_reputation_score integer,

  error                text
);

create index if not exists verifications_candidate_idx
  on verifications (candidate_id, checked_at desc);

-- ---------------------------------------------------------------------------
-- risk_scores: append-only history of scores, so threshold changes can be
-- back-tested against past data. contributing_signals stores the itemised
-- evidence that produced the number - required for the public evidence panel
-- and for later tuning against labelled datasets.
-- ---------------------------------------------------------------------------
create table if not exists risk_scores (
  id                   uuid primary key default gen_random_uuid(),
  candidate_id         uuid not null references candidates(id) on delete cascade,
  verification_id      uuid references verifications(id) on delete set null,
  score                integer not null check (score between 0 and 100),
  tier                 text not null check (tier in ('high','medium','low')),
  contributing_signals jsonb not null default '[]'::jsonb,
  weights_version      text not null default 'v1',
  computed_at          timestamptz not null default now()
);

create index if not exists risk_scores_candidate_idx
  on risk_scores (candidate_id, computed_at desc);

-- ---------------------------------------------------------------------------
-- allowlist: checked BEFORE anything else. Covers a brand's own defensive
-- registrations and any domain a human cleared after a dispute.
-- ---------------------------------------------------------------------------
create table if not exists allowlist (
  id        uuid primary key default gen_random_uuid(),
  domain    text not null unique,
  brand_id  uuid references brands(id) on delete set null,
  reason    text not null,
  added_by  text not null default 'system',
  added_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- reports: the dispute path. Anyone can say "this is my legitimate domain".
-- ---------------------------------------------------------------------------
create table if not exists reports (
  id           uuid primary key default gen_random_uuid(),
  candidate_id uuid references candidates(id) on delete set null,
  domain       text,
  kind         text not null default 'dispute'
                 check (kind in ('dispute','confirm','other')),
  note         text not null,
  contact      text,
  status       text not null default 'open'
                 check (status in ('open','resolved','dismissed')),
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  resolution   text
);

create index if not exists reports_status_idx on reports (status, created_at desc);

-- ---------------------------------------------------------------------------
-- job_runs: operational log. Also what keeps the Supabase free-tier project
-- from pausing - every scheduled run reads and writes here, which counts as
-- database activity against the 7-day inactivity timer.
-- ---------------------------------------------------------------------------
create table if not exists job_runs (
  id          uuid primary key default gen_random_uuid(),
  job         text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  stats       jsonb not null default '{}'::jsonb,
  error       text
);

create index if not exists job_runs_job_idx on job_runs (job, started_at desc);

-- ---------------------------------------------------------------------------
-- Convenience views.
-- ---------------------------------------------------------------------------
create or replace view current_scores as
select distinct on (candidate_id)
  candidate_id, id as risk_score_id, score, tier, contributing_signals,
  weights_version, computed_at
from risk_scores
order by candidate_id, computed_at desc;

create or replace view current_verifications as
select distinct on (candidate_id)
  candidate_id, id as verification_id, checked_at, resolves, a_records, has_mx,
  registrar, domain_created_at, domain_age_days, http_status, final_url,
  page_title, has_password_field, brand_terms_on_page, form_posts_offsite,
  looks_parked, content_risk_score, ip_address, asn, asn_org
from verifications
order by candidate_id, checked_at desc;

-- Public feed view. It repeats the publication gate in SQL as a second line of
-- defence behind the API layer: a bug in a route handler still cannot leak a
-- low-tier candidate, because this view never contains one.
create or replace view public_feed as
select
  c.id, c.domain, c.unicode_domain, c.first_seen_at, c.last_seen_at,
  c.edit_distance, c.homoglyph_flag, c.match_kind, c.matched_term,
  c.cert_issuer, c.cert_issued_at, c.publish_state,
  b.name as brand_name, b.slug as brand_slug, b.category as brand_category,
  s.score, s.tier, s.contributing_signals, s.computed_at as scored_at,
  v.resolves, v.has_password_field, v.domain_age_days, v.registrar,
  v.http_status, v.looks_parked, v.checked_at as last_checked_at
from candidates c
join brands b on b.id = c.matched_brand_id
left join current_scores s on s.candidate_id = c.id
left join current_verifications v on v.candidate_id = c.id
where c.publish_state in ('published', 'pending_review');
