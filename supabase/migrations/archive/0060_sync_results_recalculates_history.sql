-- Fixes a real bug reported live: Jordyn Propst (an existing iRacing
-- account whose real name changed on iRacing's side — Logan's own theory,
-- confirmed by the mechanism below) showed up on the roster with zero
-- results, and didn't even trigger the "not in roster" fallback on the
-- rounds they'd actually raced.
--
-- Root cause: recalculate_race_scores()'s entrant CTE (0058_class_season_
-- fallback_fix.sql) joins curated_race_results to drivers via an INNER JOIN
-- on iracing_cust_id — `join public.drivers d on d.iracing_cust_id =
-- rr.cust_id`. Any round scored BEFORE a cust_id had a matching drivers row
-- simply excludes that cust_id from race_scores entirely for that round —
-- no row, not an error. sync_results_with_roster() (0047) is exactly the
-- tool that links/creates a drivers row for a cust_id that's already been
-- racing without one, but it never went back and recalculated any of the
-- rounds that cust_id already appears in — it only touches the `drivers`
-- table. So the instant sync_results_with_roster() finishes:
--   1. results.ts's getRoundResults() no longer treats that cust_id as
--      unrostered (rosteredCustIds now includes them — see
--      results.ts's own `rosteredCustIds`/`unmatchedByRace` split), so the
--      "not in roster" fallback row stops appearing for their old rounds...
--   2. ...but race_scores still has zero rows for them on those old
--      rounds (recalculate_race_scores was never re-run for those specific
--      subsession_ids), so they don't appear as a scored driver either.
--      Result: invisible on every round they raced before the sync linked
--      them in, with no error and no "unrostered" tag to explain why.
--
-- Fix: right after linking/creating a driver for a cust_id, recalculate
-- every round that cust_id has a curated_race_results row in — exhibition
-- rounds included (recalculate_race_scores doesn't treat exhibition
-- specially; only standings exclusion does, elsewhere), same "recompute
-- the whole round" idempotent call Admin > Seasons' Recalculate button
-- already uses per-round in recalculate_season_scores() (0034). One round
-- failing (no ruleset assigned yet, standings locked, etc.) doesn't abort
-- the sync — same per-round try/catch that function already uses — but
-- IS now surfaced back to the caller instead of silently swallowed, so
-- Logan can see exactly which round(s) still need attention.
--
-- See this migration's companion, 0061_backfill_missing_race_scores.sql,
-- for the one-time data fix that closes this same gap retroactively for
-- every driver (Jordyn Propst included) already caught by it before this
-- function existed.
create or replace function public.sync_results_with_roster()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_default_class_id integer;
  v_new_status_id     integer;
  v_created           text[] := '{}';
  v_linked            text[] := '{}';
  v_entrant           record;
  v_match_count        integer;
  v_match_id           uuid;
  v_match_name         text;
  v_created_name       text;
  v_subsession_id       bigint;
  v_rounds_recalculated integer := 0;
  v_recalc_failed       text[] := '{}';
begin
  if not is_admin() then
    raise exception 'Only an admin can sync results with the roster'
      using errcode = 'insufficient_privilege';
  end if;

  select id into v_default_class_id from public.driver_classes order by sort_order asc limit 1;
  select id into v_new_status_id from public.driver_statuses where name = 'New';
  if v_default_class_id is null or v_new_status_id is null then
    raise exception 'driver_classes/driver_statuses is missing required rows';
  end if;

  for v_entrant in
    select
      rr.cust_id,
      (array_agg(rr.display_name order by rr.subsession_id desc))[1] as display_name
    from public.curated_race_results rr
    join public.curated_rounds cr on cr.subsession_id = rr.subsession_id
    where (cr.season_label is null or cr.season_label ~* '^ATC[0-9]+$')
      and not exists (
        select 1 from public.round_overrides ro
        where ro.subsession_id = rr.subsession_id and ro.is_exhibition
      )
      and not exists (
        select 1 from public.drivers d where d.iracing_cust_id = rr.cust_id
      )
    group by rr.cust_id
  loop
    select count(*) into v_match_count
    from public.drivers d
    where d.iracing_cust_id is null
      and lower(trim(d.name)) = lower(trim(v_entrant.display_name));

    if v_match_count = 1 then
      select d.id, d.name into v_match_id, v_match_name
      from public.drivers d
      where d.iracing_cust_id is null
        and lower(trim(d.name)) = lower(trim(v_entrant.display_name));

      update public.drivers set iracing_cust_id = v_entrant.cust_id where id = v_match_id;
      v_linked := array_append(v_linked, v_match_name);
    else
      insert into public.drivers (name, iracing_cust_id, class_id, status_id, is_rookie)
      values (v_entrant.display_name, v_entrant.cust_id, v_default_class_id, v_new_status_id, true)
      returning name into v_created_name;
      v_created := array_append(v_created, v_created_name);
    end if;

    -- This cust_id is rostered now — go back and recompute every round
    -- they already have raw results in, so their history isn't stuck
    -- invisible until someone happens to click Admin > Seasons' Recalculate
    -- for the right season. See this function's own header comment above.
    for v_subsession_id in
      select distinct rr2.subsession_id
      from public.curated_race_results rr2
      where rr2.cust_id = v_entrant.cust_id
    loop
      begin
        perform public.recalculate_race_scores(v_subsession_id);
        v_rounds_recalculated := v_rounds_recalculated + 1;
      exception when others then
        v_recalc_failed := array_append(v_recalc_failed, v_subsession_id::text || ': ' || sqlerrm);
      end;
    end loop;
  end loop;

  return jsonb_build_object(
    'created', to_jsonb(v_created),
    'linked', to_jsonb(v_linked),
    'roundsRecalculated', v_rounds_recalculated,
    'recalcFailed', to_jsonb(v_recalc_failed)
  );
end;
$$;
