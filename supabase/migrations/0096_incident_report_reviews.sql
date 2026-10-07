-- Alpha Touring Challenge — steward reviews of driver-submitted incident reports
--
-- Every admin can leave ONE review per submitted incident report (0090): the
-- driver they think is at fault (or a Racing Incident), a penalty, and a
-- written explanation. It replaces the per-steward columns of the old
-- incident spreadsheet. Reviews are advisory only: nothing here touches
-- penalties or scoring, and the real ruling is still made with "Log incident".
--
-- Rules, all enforced here rather than in the UI:
--   * Admins only. Reviews are never public, not even after the round's
--     incident report is posted.
--   * Blind until you vote: an admin can read other admins' reviews of a
--     report only once they have submitted their own review of that report
--     (or the report has been logged and voting is over). Before that they
--     can only see HOW MANY reviews exist (incident_report_review_counts
--     below).
--   * One review per admin per report. Saving again replaces it, and any
--     real change stamps edited_at, so an edit after seeing everyone else's
--     votes is visible.
--   * Locked for good once the report is first logged to the incident
--     report. Logging stamps incident_reports.reviews_closed_at (section 0
--     below), which can never be cleared — so Reopening a logged report
--     brings back Log/Dismiss but NOT voting: by then every admin has been
--     able to read every verdict, so a "blind" vote after a reopen wouldn't
--     be. Dismissed-but-never-logged reports stay reviewable.
--
-- Writes go through save_incident_report_review() (SECURITY DEFINER) rather
-- than table policies, so the lock and the one-per-admin upsert live in one
-- place. The table itself grants no insert/update/delete to anyone.

-- 0. When voting closed --------------------------------------------------------
-- Set the first time a report becomes 'logged' and sticky from then on: the
-- trigger keeps any existing value, so neither a Reopen nor a direct PATCH
-- from an admin token can clear it.
alter table incident_reports add column if not exists reviews_closed_at timestamptz;

update incident_reports set reviews_closed_at = now() where status = 'logged' and reviews_closed_at is null;

create or replace function public.stamp_incident_report_reviews_closed()
returns trigger
language plpgsql
as $$
begin
  new.reviews_closed_at := coalesce(old.reviews_closed_at, case when new.status = 'logged' then now() end);
  return new;
end;
$$;

drop trigger if exists incident_reports_stamp_reviews_closed on incident_reports;
create trigger incident_reports_stamp_reviews_closed
  before update on incident_reports
  for each row execute function public.stamp_incident_report_reviews_closed();

-- 1. The reviews ---------------------------------------------------------------
create table if not exists incident_report_reviews (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references incident_reports (id) on delete cascade,
  reviewer_id uuid not null references auth.users (id) on delete cascade,
  -- Captured at save time, same as incident_reports.reporter_name, so the
  -- review still has a name if the login is later unlinked from its driver.
  reviewer_name text,
  -- Null = Racing Incident (no driver at fault), same as penalties.driver_id.
  -- Cascade like penalties.driver_id: `set null` would silently turn a review
  -- blaming a deleted driver into a Racing Incident (and break the check below).
  driver_id uuid references drivers (id) on delete cascade,
  -- 'none' | 'warning' | '1'..'7' — the same choices as the Log incident
  -- dialog's PP dropdown. A Racing Incident is always 'none'.
  penalty text not null check (penalty in ('none', 'warning', '1', '2', '3', '4', '5', '6', '7')),
  explanation text not null check (length(btrim(explanation)) > 0 and length(explanation) <= 4000),
  created_at timestamptz not null default now(),
  -- Null until the review is changed after first being submitted.
  edited_at timestamptz,
  unique (report_id, reviewer_id),
  check (driver_id is not null or penalty = 'none')
);

create index if not exists incident_report_reviews_report_idx on incident_report_reviews (report_id);

alter table incident_report_reviews enable row level security;

-- 2. Blind-until-you-vote read access -----------------------------------------
-- SECURITY DEFINER so the policy below can look at the same table without
-- re-applying its own RLS (a policy that queries its own table directly
-- recurses).
create or replace function public.has_reviewed_incident_report(p_report_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from incident_report_reviews
    where report_id = p_report_id and reviewer_id = auth.uid()
  );
$$;

revoke all on function public.has_reviewed_incident_report(uuid) from public;
grant execute on function public.has_reviewed_incident_report(uuid) to authenticated;

drop policy if exists "admin read incident_report_reviews" on incident_report_reviews;
create policy "admin read incident_report_reviews" on incident_report_reviews
  for select using (
    is_admin() and (
      reviewer_id = (select auth.uid())
      or has_reviewed_incident_report(report_id)
      -- Once voting has closed, the reviews are a record every admin can read.
      or exists (select 1 from incident_reports r where r.id = report_id and r.reviews_closed_at is not null)
    )
  );

-- 3. Review counts (visible before you vote) ----------------------------------
-- Just the number of reviews per report for one round — never who wrote them
-- or what they said — so an admin who hasn't voted yet sees "3 reviews".
create or replace function public.incident_report_review_counts(p_subsession_id bigint)
returns table (report_id uuid, review_count integer)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.is_admin() then
    raise exception 'admins only';
  end if;
  return query
    select v.report_id, count(*)::integer
    from incident_report_reviews v
    join incident_reports r on r.id = v.report_id
    where r.subsession_id = p_subsession_id
    group by v.report_id;
end;
$$;

revoke all on function public.incident_report_review_counts(bigint) from public;
grant execute on function public.incident_report_review_counts(bigint) to authenticated;

-- 4. Saving a review -----------------------------------------------------------
create or replace function public.save_incident_report_review(
  p_report_id uuid,
  p_driver_id uuid,
  p_penalty text,
  p_explanation text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_found boolean;
  v_closed timestamptz;
  v_name text;
begin
  if v_uid is null or not public.is_admin() then
    raise exception 'admins only';
  end if;

  select true, reviews_closed_at into v_found, v_closed from incident_reports where id = p_report_id;
  if v_found is null then raise exception 'unknown incident report'; end if;
  -- The app matches on "reviews are locked" to tell the steward why the save failed.
  if v_closed is not null then raise exception 'this incident has already been logged; reviews are locked'; end if;

  if p_penalty is null or p_penalty not in ('none', 'warning', '1', '2', '3', '4', '5', '6', '7') then
    raise exception 'invalid penalty';
  end if;
  if coalesce(btrim(p_explanation), '') = '' or length(p_explanation) > 4000 then
    raise exception 'invalid explanation';
  end if;
  if p_driver_id is not null and not exists (select 1 from drivers where id = p_driver_id) then
    raise exception 'unknown driver';
  end if;

  -- A login linked to a roster driver (Admin > Users > Driver) is named after that driver.
  select coalesce(d.name, p.display_name, u.email) into v_name
  from auth.users u left join profiles p on p.id = u.id left join drivers d on d.id = p.driver_id
  where u.id = v_uid;

  insert into incident_report_reviews (report_id, reviewer_id, reviewer_name, driver_id, penalty, explanation)
  values (
    p_report_id,
    v_uid,
    v_name,
    p_driver_id,
    case when p_driver_id is null then 'none' else p_penalty end,
    btrim(p_explanation)
  )
  on conflict (report_id, reviewer_id) do update
    set reviewer_name = excluded.reviewer_name,
        driver_id = excluded.driver_id,
        penalty = excluded.penalty,
        explanation = excluded.explanation,
        -- Only a real change counts as an edit — re-saving unchanged isn't one.
        edited_at = case
          when incident_report_reviews.driver_id is distinct from excluded.driver_id
            or incident_report_reviews.penalty is distinct from excluded.penalty
            or incident_report_reviews.explanation is distinct from excluded.explanation
          then now()
          else incident_report_reviews.edited_at
        end;
end;
$$;

revoke all on function public.save_incident_report_review(uuid, uuid, text, text) from public;
grant execute on function public.save_incident_report_review(uuid, uuid, text, text) to authenticated;
