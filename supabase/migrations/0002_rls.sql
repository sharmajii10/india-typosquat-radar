-- ===========================================================================
-- Row Level Security.
--
-- Threat model: the anon key ships to every browser that loads the site. It
-- must therefore be able to read ONLY what is already meant to be public, and
-- write nothing except a dispute report. Everything else - raw candidates,
-- low-tier rows, verification detail, job logs - is service-role only.
--
-- The service_role key bypasses RLS entirely and is used solely by the job
-- routes running on the server. It is never exposed to the browser.
-- ===========================================================================

alter table brands        enable row level security;
alter table candidates    enable row level security;
alter table verifications enable row level security;
alter table risk_scores   enable row level security;
alter table allowlist     enable row level security;
alter table reports       enable row level security;
alter table job_runs      enable row level security;

-- --- brands: fully public. The watchlist is meant to be transparent. --------
drop policy if exists brands_public_read on brands;
create policy brands_public_read on brands
  for select to anon, authenticated
  using (true);

-- --- candidates: only published / pending_review rows are readable. ---------
-- 'hidden' (low tier) and 'cleared' rows are invisible to the anon key, which
-- is the database-level enforcement of the confidence gate.
drop policy if exists candidates_public_read on candidates;
create policy candidates_public_read on candidates
  for select to anon, authenticated
  using (publish_state in ('published', 'pending_review'));

-- --- verifications / risk_scores: readable only for visible candidates. -----
drop policy if exists verifications_public_read on verifications;
create policy verifications_public_read on verifications
  for select to anon, authenticated
  using (
    exists (
      select 1 from candidates c
      where c.id = verifications.candidate_id
        and c.publish_state in ('published', 'pending_review')
    )
  );

drop policy if exists risk_scores_public_read on risk_scores;
create policy risk_scores_public_read on risk_scores
  for select to anon, authenticated
  using (
    exists (
      select 1 from candidates c
      where c.id = risk_scores.candidate_id
        and c.publish_state in ('published', 'pending_review')
    )
  );

-- --- allowlist: no anon policy at all -> no anon access. --------------------
-- Publishing the allowlist would tell an attacker exactly which lookalikes are
-- pre-cleared and therefore safe to abuse.

-- --- reports: anyone may file one, nobody may read them back. ---------------
-- Reports can contain a reporter's contact details, so select stays closed.
drop policy if exists reports_public_insert on reports;
create policy reports_public_insert on reports
  for insert to anon, authenticated
  with check (
    status = 'open'
    and kind in ('dispute', 'confirm', 'other')
    and char_length(note) between 10 and 4000
    and (contact is null or char_length(contact) <= 200)
  );

-- --- job_runs: service role only. No policies. ------------------------------

-- ---------------------------------------------------------------------------
-- Views in Supabase are owned by postgres, which means by default they run with
-- the owner's privileges and BYPASS the policies above entirely. Without this
-- block, `select * from public_feed` as anon would happily return hidden rows.
--
-- security_invoker makes a view run as the querying role instead, so the
-- policies apply. It requires PostgreSQL 15 or newer. Supabase projects created
-- in the last couple of years are on 15+; if yours is older the ALTERs raise,
-- and the exception handler below turns that into a loud warning rather than a
-- silently half-applied migration.
-- ---------------------------------------------------------------------------
do $$
begin
  alter view public_feed           set (security_invoker = on);
  alter view current_scores        set (security_invoker = on);
  alter view current_verifications set (security_invoker = on);
exception
  when others then
    raise warning
      'Could not set security_invoker on the views (%). This needs PostgreSQL 15+. '
      'Until it is set, those views bypass Row Level Security - do NOT expose the '
      'anon key until you have upgraded the database or replaced the views with '
      'security-barrier equivalents.', sqlerrm;
end
$$;

-- ---------------------------------------------------------------------------
-- Explicit grants. Supabase's default privileges usually cover these, but being
-- explicit means the security posture is readable in one file rather than
-- depending on project-level defaults that may have been changed.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

grant select on brands, candidates, verifications, risk_scores to anon, authenticated;
grant select on public_feed, current_scores, current_verifications to anon, authenticated;

-- The dispute form is the only public write path.
grant insert on reports to anon, authenticated;

-- Explicitly revoke everything else the public roles must never have.
revoke all on allowlist from anon, authenticated;
revoke all on job_runs  from anon, authenticated;
revoke insert, update, delete on brands, candidates, verifications, risk_scores
  from anon, authenticated;
revoke select, update, delete on reports from anon, authenticated;
