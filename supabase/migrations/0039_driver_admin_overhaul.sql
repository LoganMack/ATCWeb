-- Driver admin screen overhaul (Logan). Several independent pieces bundled
-- into one migration since they all touch `drivers`:
--
-- 1. starting_irating — plain admin-editable integer, no automation tied to
--    it. Loose sanity bounds (not the "typical 500-12000" range Logan gave
--    only as a reference point, not a hard rule) so a fat-fingered value
--    still gets caught without rejecting a legitimately unusual number.
alter table public.drivers
  add column starting_irating integer,
  add constraint drivers_starting_irating_range
    check (starting_irating is null or (starting_irating >= 0 and starting_irating <= 20000));

comment on column public.drivers.starting_irating is 'Driver''s iRating when they joined ATC. Reference only — iRatings on iRacing typically run 500-12000, but this isn''t enforced as a hard bound.';

-- 2. created_by/updated_by — who touched this row, alongside the existing
-- created_at/updated_at (already on this table, already auto-maintained by
-- the drivers_set_updated_at trigger). Stamped by a trigger rather than
-- threaded through from application code, so it's correct no matter which
-- code path writes the row (the normal admin form, set_driver_car_number()
-- below, sync_driver_statuses() below, or any future import script) instead
-- of relying on every call site to remember to pass an actor id.
alter table public.drivers
  add column created_by uuid references auth.users(id) on delete set null,
  add column updated_by uuid references auth.users(id) on delete set null;

comment on column public.drivers.created_by is 'auth.users.id of the admin who created this driver row (auto-stamped by drivers_set_audit_fields — see that trigger). Null for rows that predate this column.';
comment on column public.drivers.updated_by is 'auth.users.id of the admin who most recently modified this driver row (auto-stamped by drivers_set_audit_fields). Null for rows that predate this column and haven''t been touched since.';

create or replace function public.set_driver_audit_fields()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by = auth.uid();
    new.updated_by = auth.uid();
  elsif tg_op = 'UPDATE' then
    new.updated_by = auth.uid();
    new.created_by = old.created_by;
  end if;
  return new;
end;
$$;

drop trigger if exists drivers_set_audit_fields on public.drivers;
create trigger drivers_set_audit_fields
  before insert or update on public.drivers
  for each row execute function public.set_driver_audit_fields();

-- 3. Car numbers — a partial unique index is the hard backstop (no two
-- ACTIVE rows can ever collide, full stop, regardless of what writes the
-- row), and set_driver_car_number() below is the app's only path for
-- actually changing a car_number, so it can enforce Logan's actual rule
-- (block if held by anyone not Inactive; silently free it up if the holder
-- IS Inactive) before the hard constraint would ever fire.
create unique index if not exists drivers_car_number_unique_idx
  on public.drivers (car_number)
  where car_number is not null;

create or replace function public.set_driver_car_number(p_driver_id uuid, p_car_number integer)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_holder record;
begin
  if not is_admin() then
    raise exception 'Only an admin can change car numbers'
      using errcode = 'insufficient_privilege';
  end if;

  if p_car_number is not null then
    select d.id, d.name, ds.name as status_name
      into v_holder
    from public.drivers d
    join public.driver_statuses ds on ds.id = d.status_id
    where d.car_number = p_car_number
      and d.id <> p_driver_id;

    if found then
      if v_holder.status_name <> 'Inactive' then
        raise exception 'Car #% is already in use by % (%)', p_car_number, v_holder.name, v_holder.status_name
          using errcode = 'unique_violation';
      end if;
      -- The current holder is Inactive — Logan: "if you overwrite the
      -- number of someone who is inactive, they should go into the
      -- unassigned category by having their number removed." Cleared
      -- BEFORE this driver's own number is set, so the two writes never
      -- collide against the unique index above even momentarily.
      update public.drivers set car_number = null where id = v_holder.id;
    end if;
  end if;

  update public.drivers set car_number = p_car_number where id = p_driver_id;
end;
$$;

-- 4. Automatic status — replaces the admin's manual Status dropdown.
--
-- Confirmed with Logan: New and Active drivers both go Inactive once their
-- most recent race is more than 45 days old (a brand-new driver's "most
-- recent race" is just their first one, which is what makes this the same
-- rule as "45 days from the first race after sign-up" for someone who's
-- only ever raced once); Veteran is exempt entirely; and an Inactive driver
-- who races again is auto-reactivated (to Active, not New/Veteran — there's
-- no rule yet for which of those a returning driver should land on) as
-- soon as they show up in a race within the last 45 days. A driver with NO
-- races on file at all (either never raced, or has no iracing_cust_id to
-- match results against) is left untouched either way — there's no race to
-- start or restart the clock from.
--
-- driver_last_race is a plain view (not baked into sync_driver_statuses
-- itself) so the admin edit page can reuse the exact same "most recent
-- race" computation for its "becomes inactive in N days" note, instead of
-- that note drifting out of sync with what the sync function actually does.
create or replace view public.driver_last_race as
select
  d.id as driver_id,
  max(cr.start_time) as last_race_at
from public.drivers d
left join public.curated_race_results rr on rr.cust_id = d.iracing_cust_id
left join public.curated_rounds cr on cr.subsession_id = rr.subsession_id
group by d.id;

comment on view public.driver_last_race is 'Every driver''s most recent race (by curated_rounds.start_time), matched via drivers.iracing_cust_id — null if they have no iracing_cust_id set or have never appeared in curated_race_results. Backs both sync_driver_statuses() and the admin driver edit page''s "becomes inactive in N days" note.';

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

  -- New/Active -> Inactive: idle more than 45 days since their most recent race.
  update public.drivers d
  set status_id = v_inactive_id
  from public.driver_statuses ds, public.driver_last_race lr
  where ds.id = d.status_id
    and lr.driver_id = d.id
    and ds.name in ('New', 'Active')
    and lr.last_race_at is not null
    and lr.last_race_at < now() - interval '45 days';
  get diagnostics v_count = row_count;
  v_changed := v_changed + v_count;

  -- Inactive -> Active: raced again within the last 45 days.
  update public.drivers d
  set status_id = v_active_id
  from public.driver_statuses ds, public.driver_last_race lr
  where ds.id = d.status_id
    and lr.driver_id = d.id
    and ds.name = 'Inactive'
    and lr.last_race_at is not null
    and lr.last_race_at >= now() - interval '45 days';
  get diagnostics v_count = row_count;
  v_changed := v_changed + v_count;

  return v_changed;
end;
$$;
