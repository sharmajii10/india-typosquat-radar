-- ---------------------------------------------------------------------------
-- 0004: carry each brand's canonical official domain into the public feed.
--
-- WHY
-- ---
-- A listing says a domain "resembles HDFC Bank". Without the real address next
-- to it, a reader has to already know what HDFC Bank's real address is - which
-- is exactly the knowledge a typosquat exists to exploit. Putting the official
-- domain beside the flagged one turns the comparison from a claim the reader
-- has to accept into something they can check in one glance.
--
-- Only the FIRST entry of official_domains is exposed. That array is ordered
-- canonical-first in scripts/seed.ts, and shipping all of them would bury the
-- comparison under subsidiary and campaign domains. Anyone who wants the full
-- set can read /api/brands, which already publishes it.
--
-- SAFETY - READ BEFORE RUNNING
-- ---------------------------
-- This replaces a view that Row Level Security depends on. A replaced view can
-- come back running as its OWNER instead of the querying role, which bypasses
-- RLS silently: the site keeps working, the feed keeps rendering, and the
-- internal low-tier candidate list quietly becomes world-readable. The
-- security_invoker setting is therefore re-applied explicitly below rather than
-- assumed to survive.
--
-- Run `npm run check:rls` after applying this. That is what proves it.
-- ---------------------------------------------------------------------------

-- THE NEW COLUMN GOES LAST, AND MUST STAY LAST.
--
-- `create or replace view` can only APPEND columns. It matches the new select
-- list against the old one positionally, so putting brand_official_domain next
-- to the other brand_* columns - which is where it belongs on readability
-- grounds - makes PostgreSQL read position 16 as an attempt to rename the
-- column already there:
--
--   ERROR: 42P16: cannot change name of view column "score"
--                 to "brand_official_domain"
--
-- Column order is invisible to the application, which selects by name, so the
-- tidier grouping is not worth a `drop view` that would take the grants and any
-- dependent objects with it. If you add another column later, append it here
-- too rather than filing it next to its relatives.
create or replace view public_feed as
select
  c.id, c.domain, c.unicode_domain, c.first_seen_at, c.last_seen_at,
  c.edit_distance, c.homoglyph_flag, c.match_kind, c.matched_term,
  c.cert_issuer, c.cert_issued_at, c.publish_state,
  b.name as brand_name, b.slug as brand_slug, b.category as brand_category,
  s.score, s.tier, s.contributing_signals, s.computed_at as scored_at,
  v.resolves, v.has_password_field, v.domain_age_days, v.registrar,
  v.http_status, v.looks_parked, v.checked_at as last_checked_at,
  -- text[] is 1-indexed in PostgreSQL. NULL for a brand with no official
  -- domain recorded, which the UI renders as no comparison rather than as an
  -- empty link.
  b.official_domains[1] as brand_official_domain
from candidates c
join brands b on b.id = c.matched_brand_id
left join current_scores s on s.candidate_id = c.id
left join current_verifications v on v.candidate_id = c.id
where c.publish_state in ('published', 'pending_review');

-- Same guard as 0002: needs PostgreSQL 15+, and a failure here must be loud
-- rather than a silently half-applied migration.
do $$
begin
  alter view public_feed set (security_invoker = on);
exception
  when others then
    raise warning
      'Could not set security_invoker on public_feed (%). This needs PostgreSQL 15+. '
      'Until it is set, that view bypasses Row Level Security - do NOT leave the '
      'anon key exposed until you have upgraded the database.', sqlerrm;
end
$$;

grant select on public_feed to anon, authenticated;
