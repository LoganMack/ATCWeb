-- Admin incident edits on Race Results, keeping the original count (intent 261117-incident-report-polish,
-- unit results-edit; FR9.1-FR9.9; rules BR9.1-BR9.11; contracts C1, C2).
--
-- What:
--   1. public.race_incident_adjustments: one row per driver per race whose incident count a full admin
--      changed, holding the count the results import gave (original_incidents) and the count now in
--      curated_race_results (adjusted_incidents). Admins and staff can read it; nobody writes it directly.
--   2. public.set_race_incidents(subsession, race, changes): the only write path. Full admins only. It
--      validates the raw JSON before any cast, locks the race's rows, keeps the original count the first time
--      a driver is adjusted, deletes the adjustment when a count is set back to its original, and changes
--      curated_race_results in one UPDATE, so the existing scoring triggers re-score the round once.
--   3. private.reapply_incident_adjustment(), a BEFORE INSERT trigger on curated_race_results. The CSV import
--      deletes a race's rows and inserts them again; the trigger keeps an admin's adjusted count over the
--      re-imported one and makes the newly imported count the original (C2), or drops the adjustment when
--      the import now agrees with it.
--   4. curated_race_results_shown gains original_incidents as its last column: the original count when the
--      current count differs from it, otherwise null. Who adjusted it and when stay admin-only.
--
-- Why: the owner corrects incident counts after a race (for example a count iRacing got wrong). The scoring
-- reads curated_race_results, so the corrected value must live there; the original is kept so the page can
-- say "Incidents adjusted from X to Y." The rule is enforced here, not in page code.
--
-- Assumption: results are written only by insert or upsert (the CSV import and any on-conflict upsert). A
-- plain UPDATE of curated_race_results.incidents outside set_race_incidents would bypass the adjustment.
--
-- Expand only: a new table, functions and trigger, and a new last column on the view. The code on main never
-- selects original_incidents and keeps working. Undo with
-- supabase/down/20261119120000_race_incident_adjustments.down.sql.

-- 1. The adjustments table --------------------------------------------------------------------------------
create table public.race_incident_adjustments (
  subsession_id bigint not null references public.curated_rounds (subsession_id) on delete cascade,
  race_number integer not null check (race_number >= 1),
  cust_id bigint not null check (cust_id > 0),
  original_incidents integer not null check (original_incidents between 0 and 999),
  adjusted_incidents integer not null check (adjusted_incidents between 0 and 999),
  adjusted_by uuid not null,
  adjusted_at timestamp with time zone not null default now(),
  primary key (subsession_id, race_number, cust_id),
  check (adjusted_incidents <> original_incidents)
);

comment on table public.race_incident_adjustments is
  'Incident counts a full admin changed on Race Results, with the imported original. Written only by '
  'set_race_incidents and the reapply_incident_adjustment trigger; a plain UPDATE of '
  'curated_race_results.incidents bypasses it.';

alter table public.race_incident_adjustments enable row level security;
revoke all on table public.race_incident_adjustments from public, anon, authenticated;
grant select on table public.race_incident_adjustments to authenticated;

create policy race_incident_adjustments_admin_select on public.race_incident_adjustments
  for select to authenticated using (private.is_admin());

-- 2. The write function -------------------------------------------------------------------------------------
create type private.incident_change as (
  cust_id bigint,
  new_count integer,
  current_count integer,
  stored_original integer,
  action text
);

create function public.set_race_incidents(p_subsession_id bigint, p_race_number integer, p_changes jsonb)
  returns jsonb
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_element jsonb;
  v_cust numeric;
  v_count numeric;
  v_seen bigint[] := '{}';
  v_missing bigint;
  v_bad bigint;
  v_changes private.incident_change[];
  v_changed integer;
  v_issue text;
begin
  if not private.is_full_admin() then
    raise exception 'Only full admins can edit results.' using errcode = '42501';
  end if;

  if p_subsession_id is null or p_race_number is null or p_race_number < 1 or p_changes is null
     or jsonb_typeof(p_changes) <> 'array'
     or jsonb_array_length(p_changes) < 1 or jsonb_array_length(p_changes) > 200 then
    raise exception 'Invalid incident changes.' using errcode = '22023';
  end if;

  -- Validate the raw JSON before any cast, so a bad value is refused with the driver it belongs to.
  for v_element in select e from jsonb_array_elements(p_changes) e loop
    v_cust := null;
    if jsonb_typeof(v_element) = 'object' and jsonb_typeof(v_element -> 'cust_id') = 'number' then
      v_cust := (v_element ->> 'cust_id')::numeric;
      if v_cust <> trunc(v_cust) or v_cust < 1 or v_cust > 9007199254740991 then
        v_cust := null;
      end if;
    end if;
    if v_cust is null then
      raise exception 'Invalid incident changes.' using errcode = '22023';
    end if;
    if jsonb_typeof(v_element -> 'incidents') is distinct from 'number' then
      raise exception 'Invalid incident count for driver %.', v_cust::bigint
        using errcode = '22023', detail = (v_cust::bigint)::text;
    end if;
    v_count := (v_element ->> 'incidents')::numeric;
    if v_count <> trunc(v_count) or v_count < 0 or v_count > 999 then
      raise exception 'Invalid incident count for driver %.', v_cust::bigint
        using errcode = '22023', detail = (v_cust::bigint)::text;
    end if;
    if v_cust::bigint = any (v_seen) then
      raise exception 'Invalid incident count for driver %.', v_cust::bigint
        using errcode = '22023', detail = (v_cust::bigint)::text;
    end if;
    v_seen := v_seen || v_cust::bigint;
  end loop;

  -- A second save of the same race waits here, then reads the first save's counts.
  perform 1 from public.curated_race_results r
  where r.subsession_id = p_subsession_id and r.race_number = p_race_number
  for update;

  select c.cust_id into v_missing
  from (
    select (e ->> 'cust_id')::numeric::bigint as cust_id, ord
    from jsonb_array_elements(p_changes) with ordinality as x (e, ord)
  ) c
  where not exists (
    select 1 from public.curated_race_results r
    where r.subsession_id = p_subsession_id and r.race_number = p_race_number and r.cust_id = c.cust_id
  )
  order by c.ord
  limit 1;
  if v_missing is not null then
    raise exception 'Driver % is not in race % of this round.', v_missing, p_race_number
      using errcode = 'P0002', detail = v_missing::text;
  end if;

  select r.cust_id into v_bad
  from (
    select (e ->> 'cust_id')::numeric::bigint as cust_id, ord
    from jsonb_array_elements(p_changes) with ordinality as x (e, ord)
  ) c
  join public.curated_race_results r
    on r.subsession_id = p_subsession_id and r.race_number = p_race_number and r.cust_id = c.cust_id
  where r.incidents is null or r.incidents < 0 or r.incidents > 999
  order by c.ord
  limit 1;
  if v_bad is not null then
    raise exception 'Invalid incident count for driver %.', v_bad
      using errcode = '22023', detail = v_bad::text;
  end if;

  -- Classify every change once, before any write.
  select coalesce(array_agg(row(
           c.cust_id,
           c.new_count,
           r.incidents,
           a.original_incidents,
           case when c.new_count = coalesce(a.original_incidents, r.incidents) then 'revert' else 'adjust' end
         )::private.incident_change), '{}')
    into v_changes
  from (
    select (e ->> 'cust_id')::numeric::bigint as cust_id, (e ->> 'incidents')::numeric::integer as new_count
    from jsonb_array_elements(p_changes) e
  ) c
  join public.curated_race_results r
    on r.subsession_id = p_subsession_id and r.race_number = p_race_number and r.cust_id = c.cust_id
  left join public.race_incident_adjustments a
    on a.subsession_id = p_subsession_id and a.race_number = p_race_number and a.cust_id = c.cust_id
  where c.new_count <> r.incidents;

  v_changed := coalesce(array_length(v_changes, 1), 0);

  if v_changed > 0 then
    delete from public.race_incident_adjustments a
    using unnest(v_changes) x
    where x.action = 'revert'
      and a.subsession_id = p_subsession_id and a.race_number = p_race_number and a.cust_id = x.cust_id;

    insert into public.race_incident_adjustments as a
      (subsession_id, race_number, cust_id, original_incidents, adjusted_incidents, adjusted_by, adjusted_at)
    select p_subsession_id, p_race_number, x.cust_id, coalesce(x.stored_original, x.current_count), x.new_count,
           auth.uid(), now()
    from unnest(v_changes) x
    where x.action = 'adjust'
    on conflict (subsession_id, race_number, cust_id) do update
      set adjusted_incidents = excluded.adjusted_incidents,
          adjusted_by = excluded.adjusted_by,
          adjusted_at = excluded.adjusted_at;

    -- One statement, so the statement-level scoring triggers re-score the round once. A locked season
    -- raises SC001 there and undoes the whole save.
    update public.curated_race_results r
    set incidents = x.new_count, updated_at = now()
    from unnest(v_changes) x
    where r.subsession_id = p_subsession_id and r.race_number = p_race_number and r.cust_id = x.cust_id
      and r.incidents is distinct from x.new_count;
  end if;

  select si.message into v_issue from public.scoring_issues si where si.subsession_id = p_subsession_id;

  return jsonb_build_object('changed', v_changed, 'scoring_issue', v_issue);
end;
$$;

comment on function public.set_race_incidents(bigint, integer, jsonb) is
  'Full admins only: sets incident counts for drivers in one race ([{cust_id, incidents}], 1-200 entries, '
  'whole numbers 0-999), keeps the imported original in race_incident_adjustments and re-scores the round. '
  'Returns {changed, scoring_issue}.';

revoke all on function public.set_race_incidents(bigint, integer, jsonb) from public, anon;
grant execute on function public.set_race_incidents(bigint, integer, jsonb) to authenticated;

-- 3. The re-import trigger --------------------------------------------------------------------------------------
create function private.reapply_incident_adjustment() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_adjustment public.race_incident_adjustments;
begin
  select * into v_adjustment
  from public.race_incident_adjustments a
  where a.subsession_id = new.subsession_id and a.race_number = new.race_number and a.cust_id = new.cust_id
  for update;

  if not found then
    return new;
  end if;

  -- The import now agrees with the admin's count: nothing is adjusted any more.
  if new.incidents is not distinct from v_adjustment.adjusted_incidents then
    delete from public.race_incident_adjustments a
    where a.subsession_id = new.subsession_id and a.race_number = new.race_number and a.cust_id = new.cust_id;
    return new;
  end if;

  -- An imported count the table can't hold as an original: keep the adjusted count and the old original.
  if new.incidents is null or new.incidents < 0 or new.incidents > 999 then
    new.incidents := v_adjustment.adjusted_incidents;
    return new;
  end if;

  -- C2: the newly imported count becomes the original, and the admin's count stays.
  update public.race_incident_adjustments a
  set original_incidents = new.incidents
  where a.subsession_id = new.subsession_id and a.race_number = new.race_number and a.cust_id = new.cust_id;
  new.incidents := v_adjustment.adjusted_incidents;
  return new;
end;
$$;

revoke all on function private.reapply_incident_adjustment() from public, anon, authenticated;

create trigger reapply_incident_adjustment before insert on public.curated_race_results
  for each row execute function private.reapply_incident_adjustment();

-- 4. The masked results view gains original_incidents -----------------------------------------------------------
create or replace view public.curated_race_results_shown with (security_invoker = false, security_barrier = true) as
select
  r.subsession_id,
  r.race_number,
  case when h.name_hidden then private.hidden_cust_id(rd.id) else r.cust_id end as cust_id,
  case when h.name_hidden then 'Hidden Driver' else r.display_name end as display_name,
  r.car_name,
  r.car_class_name,
  r.finish_position,
  r.starting_position,
  r.laps_complete,
  r.laps_led,
  r.interval_ten_thousandths,
  r.average_lap_ten_thousandths,
  r.best_lap_ten_thousandths,
  r.incidents,
  r.reason_out,
  r.penalty_points,
  r.adjusted_position,
  r.created_at,
  r.updated_at,
  case when rd.id is null then null else rd.id end as roster_driver_id,
  case when a.original_incidents is distinct from r.incidents then a.original_incidents end as original_incidents
from public.curated_race_results r
left join public.drivers rd on rd.iracing_cust_id = r.cust_id
left join private.hidden_drivers h on h.driver_id = rd.id
left join public.race_incident_adjustments a
  on a.subsession_id = r.subsession_id and a.race_number = r.race_number and a.cust_id = r.cust_id;

comment on view public.curated_race_results_shown is
  'curated_race_results for pages (U4): a hidden roster driver shows as "Hidden Driver" with a stand-in cust_id. '
  'original_incidents is the imported count when an admin changed it, otherwise null.';

revoke all on table public.curated_race_results_shown from public, anon, authenticated, service_role;
grant select on table public.curated_race_results_shown to anon, authenticated, service_role;
