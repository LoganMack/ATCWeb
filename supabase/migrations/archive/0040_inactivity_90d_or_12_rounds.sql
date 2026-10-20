-- Revises the inactivity threshold introduced in 0039_driver_admin_overhaul.sql.
-- Logan: "It should be after 90 days OR 12 rounds, whichever is longer."
--
-- Read as: take whichever of the two thresholds takes LONGER to satisfy, and
-- only flip a driver to Inactive once that longer one has actually elapsed.
-- Concretely that means BOTH conditions must independently be true — if
-- rounds run roughly weekly, 12 rounds (~12 weeks) is the binding constraint
-- and a driver stays New/Active past the 90-day mark until the 12th round
-- happens; if rounds are spread out (biweekly+), 90 days is the binding
-- constraint and a driver stays New/Active past 12 rounds until day 90.
-- Requiring both conditions is exactly equivalent to waiting for the max of
-- the two, so this replaces the old flat "45 days" rule with:
--
--   days_since_last_race >= 90  AND  official_rounds_since_last_race >= 12
--
-- "Rounds" = official curated_rounds run by the league since the driver's
-- last race, league-wide (not scoped to their season/class) — that's the
-- natural reading of "12 rounds" as an activity gap, not a per-season count.
--
-- The Inactive -> Active reactivation rule stays the exact logical complement
-- of the same predicate (NOT both conditions), same symmetric shape the
-- original 45-day version used — a driver is Active/New whenever it is NOT
-- the case that both thresholds have been crossed.
create or replace view public.driver_last_race as
with lr as (
  select
    d.id as driver_id,
    max(cr.start_time) as last_race_at
  from public.drivers d
  left join public.curated_race_results rr on rr.cust_id = d.iracing_cust_id
  left join public.curated_rounds cr on cr.subsession_id = rr.subsession_id
  group by d.id
)
select
  lr.driver_id,
  lr.last_race_at,
  case
    when lr.last_race_at is null then null
    else (
      select count(*)::integer
      from public.curated_rounds cr2
      where cr2.status = 'official'
        and cr2.start_time > lr.last_race_at
    )
  end as rounds_since_last_race
from lr;

comment on view public.driver_last_race is 'Every driver''s most recent race (by curated_rounds.start_time), matched via drivers.iracing_cust_id, plus a count of official league rounds run since then (league-wide, not season/class-scoped) — null if they have no iracing_cust_id set or have never appeared in curated_race_results. Backs both sync_driver_statuses() and the admin driver edit page''s inactivity note. See 0040_inactivity_90d_or_12_rounds.sql for the 90-day/12-round threshold this feeds.';

create or replace function public.sync_driver_statuses()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_active_id   integer;
  v_inactive_id integer;
  v_changed     integer := 0;
  v_count       integer;
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

  -- New/Active -> Inactive: both 90 days AND 12 official rounds have passed
  -- since their most recent race (whichever threshold takes longer to
  -- satisfy is effectively the one enforced, since both are required).
  update public.drivers d
  set status_id = v_inactive_id
  from public.driver_statuses ds, public.driver_last_race lr
  where ds.id = d.status_id
    and lr.driver_id = d.id
    and ds.name in ('New', 'Active')
    and lr.last_race_at is not null
    and lr.last_race_at < now() - interval '90 days'
    and lr.rounds_since_last_race >= 12;
  get diagnostics v_count = row_count;
  v_changed := v_changed + v_count;

  -- Inactive -> Active: logical complement — NOT (90+ days AND 12+ rounds)
  -- since their most recent race, i.e. at least one threshold hasn't been
  -- crossed, which in practice means they've raced again recently.
  update public.drivers d
  set status_id = v_active_id
  from public.driver_statuses ds, public.driver_last_race lr
  where ds.id = d.status_id
    and lr.driver_id = d.id
    and ds.name = 'Inactive'
    and lr.last_race_at is not null
    and not (lr.last_race_at < now() - interval '90 days' and lr.rounds_since_last_race >= 12);
  get diagnostics v_count = row_count;
  v_changed := v_changed + v_count;

  return v_changed;
end;
$$;
