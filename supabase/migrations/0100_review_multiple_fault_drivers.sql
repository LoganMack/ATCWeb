-- Alpha Touring Challenge — steward reviews can blame more than one car
--
-- A steward review (0096) used to name ONE driver at fault (or none, for a
-- Racing Incident) and ONE suggested penalty. Incidents can have several cars
-- at fault, each deserving a different penalty, and "Log incident" now records
-- one penalty per at-fault car — so a review now lists each car it blames with
-- that car's own suggested penalty, in incident_report_review_drivers below.
-- No rows = Racing Incident.
--
-- incident_report_reviews keeps one row per steward per report (the
-- explanation, timestamps, and everything the blind-voting rules in 0096/0099
-- key off); only driver_id/penalty move out to the child table. Existing
-- reviews are copied across before those two columns are dropped.
--
-- Deploy together with the app change that calls the new
-- save_incident_report_review(uuid, jsonb, text): the old 4-argument version
-- is dropped here, so the previous app build can no longer save reviews.

-- 1. The at-fault cars of each review -----------------------------------------
create table if not exists incident_report_review_drivers (
  review_id uuid not null references incident_report_reviews (id) on delete cascade,
  -- Cascade like incident_report_reviews.driver_id did (0096).
  driver_id uuid not null references drivers (id) on delete cascade,
  -- 'none' | 'warning' | '1'..'7' — the same choices as before, now per car.
  penalty text not null check (penalty in ('none', 'warning', '1', '2', '3', '4', '5', '6', '7')),
  primary key (review_id, driver_id)
);

alter table incident_report_review_drivers enable row level security;

-- Readable exactly when the review itself is: the subquery runs under the
-- caller's own RLS on incident_report_reviews, so the blind-until-you-vote
-- rules (0096, 0099) carry over without being repeated here. Writes only go
-- through save_incident_report_review() below.
drop policy if exists "read with review incident_report_review_drivers" on incident_report_review_drivers;
create policy "read with review incident_report_review_drivers" on incident_report_review_drivers
  for select using (
    exists (select 1 from incident_report_reviews v where v.id = review_id)
  );

-- 2. Copy existing reviews across, then drop the old columns -------------------
-- Guarded so the migration can be re-run after the columns are gone.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'incident_report_reviews' and column_name = 'driver_id'
  ) then
    insert into incident_report_review_drivers (review_id, driver_id, penalty)
    select id, driver_id, penalty from incident_report_reviews where driver_id is not null
    on conflict do nothing;
  end if;
end;
$$;

-- Also drops 0096's "driver_id is not null or penalty = 'none'" check.
alter table incident_report_reviews drop column if exists driver_id;
alter table incident_report_reviews drop column if exists penalty;

-- 3. Saving a review -----------------------------------------------------------
-- p_faults is a JSON array of {"driver_id": uuid, "penalty": text}, one per
-- car the steward blames; an empty array is a Racing Incident. Everything
-- else — admin-only, the lock once logged, no reviewing your own incident
-- (0099), one review per admin, edited_at only on a real change — is as before.
drop function if exists public.save_incident_report_review(uuid, uuid, text, text);

create or replace function public.save_incident_report_review(
  p_report_id uuid,
  p_faults jsonb,
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
  v_review_id uuid;
  v_old_faults jsonb;
  v_new_faults jsonb;
  v_old_explanation text;
begin
  if v_uid is null or not public.is_admin() then
    raise exception 'admins only';
  end if;

  select true, reviews_closed_at into v_found, v_closed from incident_reports where id = p_report_id;
  if v_found is null then raise exception 'unknown incident report'; end if;
  -- The app matches on "reviews are locked" to tell the steward why the save failed.
  if v_closed is not null then raise exception 'this incident has already been logged; reviews are locked'; end if;
  -- The app matches on "involved in this incident" likewise (0099).
  if public.is_involved_in_incident_report(p_report_id) then
    raise exception 'you were involved in this incident and cannot review it';
  end if;

  if p_faults is null or jsonb_typeof(p_faults) <> 'array' or jsonb_array_length(p_faults) > 50 then
    raise exception 'invalid drivers';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_faults) f
    where jsonb_typeof(f) <> 'object'
      or coalesce(f->>'penalty', '') not in ('none', 'warning', '1', '2', '3', '4', '5', '6', '7')
      or coalesce(f->>'driver_id', '') !~ '^[0-9a-fA-F-]{36}$'
  ) then
    raise exception 'invalid drivers';
  end if;
  if (select count(distinct f->>'driver_id') from jsonb_array_elements(p_faults) f) <> jsonb_array_length(p_faults) then
    raise exception 'invalid drivers';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_faults) f
    where not exists (select 1 from drivers d where d.id = (f->>'driver_id')::uuid)
  ) then
    raise exception 'unknown driver';
  end if;
  if coalesce(btrim(p_explanation), '') = '' or length(p_explanation) > 4000 then
    raise exception 'invalid explanation';
  end if;

  -- Canonical form (sorted by driver) so "same cars, same penalties" compares equal.
  select coalesce(jsonb_agg(jsonb_build_object('driver_id', lower(f->>'driver_id'), 'penalty', f->>'penalty') order by lower(f->>'driver_id')), '[]'::jsonb)
  into v_new_faults
  from jsonb_array_elements(p_faults) f;

  -- A login linked to a roster driver (Admin > Users > Driver) is named after that driver.
  select coalesce(d.name, p.display_name, u.email) into v_name
  from auth.users u left join profiles p on p.id = u.id left join drivers d on d.id = p.driver_id
  where u.id = v_uid;

  select v.id, v.explanation into v_review_id, v_old_explanation
  from incident_report_reviews v
  where v.report_id = p_report_id and v.reviewer_id = v_uid
  for update;

  if v_review_id is null then
    insert into incident_report_reviews (report_id, reviewer_id, reviewer_name, explanation)
    values (p_report_id, v_uid, v_name, btrim(p_explanation))
    returning id into v_review_id;
  else
    select coalesce(jsonb_agg(jsonb_build_object('driver_id', rd.driver_id::text, 'penalty', rd.penalty) order by rd.driver_id::text), '[]'::jsonb)
    into v_old_faults
    from incident_report_review_drivers rd
    where rd.review_id = v_review_id;

    update incident_report_reviews
    set reviewer_name = v_name,
        explanation = btrim(p_explanation),
        -- Only a real change counts as an edit — re-saving unchanged isn't one.
        edited_at = case
          when v_old_explanation is distinct from btrim(p_explanation) or v_old_faults is distinct from v_new_faults
          then now()
          else edited_at
        end
    where id = v_review_id;

    delete from incident_report_review_drivers where review_id = v_review_id;
  end if;

  insert into incident_report_review_drivers (review_id, driver_id, penalty)
  select v_review_id, (f->>'driver_id')::uuid, f->>'penalty'
  from jsonb_array_elements(v_new_faults) f;
end;
$$;

revoke all on function public.save_incident_report_review(uuid, jsonb, text) from public;
grant execute on function public.save_incident_report_review(uuid, jsonb, text) to authenticated;
