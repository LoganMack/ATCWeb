-- Alpha Touring Challenge — stewards can't review incidents they were in
--
-- A steward whose login is linked to a roster driver (Admin > Users > Driver,
-- profiles.driver_id) can no longer leave a review (0096) on a driver-submitted
-- incident report that lists that driver among its cars
-- (incident_report_drivers). They can still read every other steward's review
-- of it: blind-until-you-vote exists to keep a voter's verdict independent, and
-- someone who can't vote has no verdict to protect, so there's nothing to hide.
--
-- Enforced here, not just in the UI: save_incident_report_review() refuses the
-- write and the read policy lets the involved steward through.
--
-- A login with no linked driver is never "involved". A review an involved
-- steward saved before this migration stays as it was (it still counts), but
-- they can no longer edit it.

-- 1. Is the caller one of this report's drivers? -------------------------------
-- SECURITY DEFINER for the same reason as has_reviewed_incident_report (0096):
-- it's called from a policy, and reads profiles/incident_report_drivers without
-- re-applying their RLS.
create or replace function public.is_involved_in_incident_report(p_report_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from incident_report_drivers ird
    join profiles p on p.driver_id = ird.driver_id
    where ird.report_id = p_report_id and p.id = auth.uid()
  );
$$;

revoke all on function public.is_involved_in_incident_report(uuid) from public;
grant execute on function public.is_involved_in_incident_report(uuid) to authenticated;

-- 2. Involved stewards can read the reviews -----------------------------------
drop policy if exists "admin read incident_report_reviews" on incident_report_reviews;
create policy "admin read incident_report_reviews" on incident_report_reviews
  for select using (
    is_admin() and (
      reviewer_id = (select auth.uid())
      or has_reviewed_incident_report(report_id)
      -- Can't vote on it (section 3), so there's no blind vote to protect.
      or is_involved_in_incident_report(report_id)
      -- Once voting has closed, the reviews are a record every admin can read.
      or exists (select 1 from incident_reports r where r.id = report_id and r.reviews_closed_at is not null)
    )
  );

-- 3. ...but can't write one ---------------------------------------------------
-- Same as 0096's version plus the involvement check.
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
  -- The app matches on "involved in this incident" likewise.
  if public.is_involved_in_incident_report(p_report_id) then
    raise exception 'you were involved in this incident and cannot review it';
  end if;

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
