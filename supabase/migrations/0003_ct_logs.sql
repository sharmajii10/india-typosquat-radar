-- ===========================================================================
-- Direct Certificate Transparency log reading.
--
-- Replaces polling crt.sh, which is a single third-party front-end that returns
-- 502s for hours and answers HTTP 200 with an empty array while broken. Reading
-- the logs directly removes that dependency: they are operated by Google,
-- Cloudflare, DigiCert and Let's Encrypt, and are the source crt.sh reads.
--
-- Reading a log means walking forward through an append-only list by index, so
-- the only state needed is "where did we get to". That is this table.
-- ===========================================================================

create table if not exists ct_logs (
  id              uuid primary key default gen_random_uuid(),
  -- Log base URL, always with a trailing slash, e.g.
  -- https://ct.googleapis.com/logs/us1/argon2026h2/
  url             text not null unique,
  description     text,
  operator        text,
  enabled         boolean not null default true,

  -- Next entry index to read. bigint is not optional: the large logs are well
  -- past two billion entries and an integer column would overflow.
  last_index      bigint not null default 0,

  -- Most recent tree size we saw, so the gap to last_index shows how far
  -- behind the scanner is running.
  tree_size       bigint,

  entries_scanned bigint not null default 0,
  sightings_found bigint not null default 0,
  last_scanned_at timestamptz,
  last_error      text,
  created_at      timestamptz not null default now()
);

-- The scanner picks the log it has looked at least recently, so every log gets
-- covered rather than the first one absorbing the whole budget.
create index if not exists ct_logs_rotation_idx
  on ct_logs (enabled, last_scanned_at nulls first);

-- ---------------------------------------------------------------------------
-- Row Level Security: service role only.
--
-- Scan cursors are internal operational state. They are not secret exactly, but
-- there is no reason to expose them, and the default posture for a new table
-- should be closed rather than open.
-- ---------------------------------------------------------------------------
alter table ct_logs enable row level security;

revoke all on ct_logs from anon, authenticated;
