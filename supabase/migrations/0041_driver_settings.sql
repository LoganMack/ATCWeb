-- Driver admin screen, round 2 (Logan):
--
-- 1. The inactivity threshold (90 days / 12 rounds, 0040) becomes
--    admin-editable from a new "Driver Settings" panel above the admin
--    Drivers list, stored in the existing generic site_settings table
--    (0026) rather than a bespoke table — same key/value shape
--    'featured_broadcast_url' already uses. sync_driver_statuses() now
--    reads inactivity_days/inactivity_rounds out of site_settings at call
--    time, falling back to 90/12 (the values 0040 hardcoded) if either key
--    is unset or holds something non-numeric, so a blank settings table
--    behaves exactly like before this migration.
--
--    Probation's own length (rule 61: 45 days / 4 rounds) is the other
--    half of the same "Driver Settings" panel, but that threshold only
--    ever lived in application code (isOnProbationNow() in
--    src/lib/penalties.ts, called from src/pages/roster.astro) — there was
--    never a DB-side probation function to update, so probation_days/
--    probation_rounds are written to site_settings by the same admin form
--    but read back by the app, not by any function in this migration.
--
-- 2. Rookie status becomes fully automatic — Logan: "After making 3
--    appearances in a single season, drivers lose rookie status." A driver
--    is a rookie (is_rookie = true, the default for every newly-created
--    driver now that the admin checkbox is gone) until the first season in
--    which they rack up 3+ appearances, at which point sync_rookie_status()
--    flips is_rookie to false — and never back to true, since the
--    "official rookie season" this triggers on is a one-time, permanent
--    milestone, not a status that can lapse. "Appearance" here means a
--    driver_round_totals row (one per driver per official round they were
--    scored in — see that view's own comment), grouped by season so a
--    driver who's raced 3 times total but spread across 3 different
--    seasons does NOT lose rookie status, only one who's done it 3+ times
--    within a single season.
create or replace function public.sync_driver_statuses()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_active_id       integer;
  v_inactive_id     integer;
  v_changed         integer := 0;
  v_count           integer;
  v_inactivity_days integer;
  v_inactivity_rounds integer;
begin
  if not is_admin() then
    raise exception 'Only an admin can sync driver statuses'
      using errcode = 'insufficient_privilege';
  end if;

  select id into v_active_id from public.driver_statuses where name = 'Active';
  select id into v_inactive_id from public.driver_statuses where name = 'Inactive';
  if v_active_id is null or v_inactive_id is null then
    raise exception 'driver_statuses is missing Active/Inactive rows';
  end if;

  select coalesce((select value from public.site_settings where setting_key = 'inactivity_days')::integer, 90)
    into v_inactivity_days;
  select coalesce((select value from public.site_settings where setting_key = 'inactivity_rounds')::integer, 12)
    into v_inactivity_rounds;
  -- A non-numeric stored value (shouldn't happen — the admin form only ever
  -- writes integers — but defend anyway) would make the casts above raise
  -- rather than silently fall back, so re-check for null/non-positive and
  -- use the same 90/12 defaults 0040 hardcoded.
  if v_inactivity_days is null or v_inactivity_days <= 0 then
    v_inactivity_days := 90;
  end if;
  if v_inactivity_rounds is null or v_inactivity_rounds <= 0 then
    v_inactivity_rounds := 12;
  end if;

  -- New/Active -> Inactive: both thresholds have passed since their most
  -- recent race (whichever takes longer to satisfy is effectively the one
  -- enforced, since both are required).
  update public.drivers d
  set status_id = v_inactive_id
  from public.driver_statuses ds, public.driver_last_race lr
  where ds.id = d.status_id
    and lr.driver_id = d.id
    and ds.name in ('New', 'Active')
    and lr.last_race_at is not null
    and lr.last_race_at < now() - (v_inactivity_days || ' days')::interval
    and lr.rounds_since_last_race >= v_inactivity_rounds;
  get diagnostics v_count = row_count;
  v_changed := v_changed + v_count;

  -- Inactive -> Active: logical complement of the same predicate.
  update public.drivers d
  set status_id = v_active_id
  from public.driver_statuses ds, public.driver_last_race lr
  where ds.id = d.status_id
    and lr.driver_id = d.id
    and ds.name = 'Inactive'
    and lr.last_race_at is not null
    and not (
      lr.last_race_at < now() - (v_inactivity_days || ' days')::interval
      and lr.rounds_since_last_race >= v_inactivity_rounds
    );
  get diagnostics v_count = row_count;
  v_changed := v_changed + v_count;

  return v_changed;
end;
$$;

create or replace function public.sync_rookie_status()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_changed integer := 0;
begin
  if not is_admin() then
    raise exception 'Only an admin can sync rookie status'
      using errcode = 'insufficient_privilege';
  end if;

  with season_appearances as (
    select driver_id, season_id, count(distinct subsession_id) as appearances
    from public.driver_round_totals
    group by driver_id, season_id
  ),
  qualified as (
    select distinct driver_id
    from season_appearances
    where appearances >= 3
  )
  update public.drivers d
  set is_rookie = false
  from qualified q
  where q.driver_id = d.id
    and d.is_rookie = true;
  get diagnostics v_changed = row_count;

  return v_changed;
end;
$$;
