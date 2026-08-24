-- sync_driver_statuses() has never had a path to Inactive for a driver who
-- has NEVER raced (no iracing_cust_id match in driver_last_race at all) —
-- 0039_driver_admin_overhaul.sql's own header comment says so explicitly:
-- "A driver with NO races on file at all ... is left untouched either way —
-- there's no race to start or restart the clock from." That was a
-- deliberate simplification at the time, but it contradicts what the admin
-- UI has always told admins would happen: buildInactivityNote() (see
-- src/lib/supabase.ts) shows a driver with no last race the message
-- "Inactive if absent {inactivityDays} days and {inactivityRounds} rounds
-- after sign-up" — a promise the DB side never actually kept. In practice
-- this meant a driver row added straight into `drivers` (by hand, or via a
-- bulk migration/import) with a real sign_up_date but no race yet stayed
-- "New" forever, no matter how many months went by — the exact symptom
-- Logan hit after bulk-adding driver rows with sign-up dates via migration
-- and finding their status never caught up.
--
-- Adds the missing branch: a 'New' driver who has never appeared in
-- driver_last_race (last_race_at is null) goes Inactive once BOTH
-- configured thresholds have elapsed since sign_up_date instead of since a
-- last race — same "count of official curated_rounds since the reference
-- date" shape driver_last_race already uses for rounds_since_last_race,
-- just measured from sign_up_date. A driver with no sign_up_date at all
-- still can't be evaluated (nothing to measure from) and is left alone, as
-- before.
--
-- Deliberately restricted to status = 'New': 'Active' is unreachable
-- without ever having raced (the only path to Active is the Inactive ->
-- Active branch below, which requires driver_last_race.last_race_at to be
-- non-null), so a never-raced driver can only be 'New' already, or already
-- 'Inactive' from a previous run of this function.
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
  if v_inactivity_days is null or v_inactivity_days <= 0 then
    v_inactivity_days := 90;
  end if;
  if v_inactivity_rounds is null or v_inactivity_rounds <= 0 then
    v_inactivity_rounds := 12;
  end if;

  -- New/Active -> Inactive (has raced at least once): both thresholds have
  -- passed since their most recent race.
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

  -- New -> Inactive (never raced at all): same two thresholds, measured
  -- from sign_up_date since there's no race to measure from. See this
  -- migration's header comment for why this branch was missing entirely
  -- before.
  update public.drivers d
  set status_id = v_inactive_id
  from public.driver_statuses ds, public.driver_last_race lr
  where ds.id = d.status_id
    and lr.driver_id = d.id
    and ds.name = 'New'
    and lr.last_race_at is null
    and d.sign_up_date is not null
    and d.sign_up_date < (now() - (v_inactivity_days || ' days')::interval)::date
    and (
      select count(*)::integer
      from public.curated_rounds cr
      where cr.status = 'official'
        and cr.start_time > d.sign_up_date
    ) >= v_inactivity_rounds;
  get diagnostics v_count = row_count;
  v_changed := v_changed + v_count;

  -- Inactive -> Active: logical complement of the raced-before rule. A
  -- never-raced driver can't come back through here — they'd need to
  -- actually race first, at which point driver_last_race.last_race_at
  -- becomes non-null and the ordinary first branch above takes over for
  -- them going forward.
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
