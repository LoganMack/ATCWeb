-- One-time data fix, companion to 0060_sync_results_recalculates_history.sql.
--
-- 0060 stops this gap from recurring going forward, but doesn't touch
-- anyone already caught by it — every driver whose cust_id got linked or
-- created by sync_results_with_roster() at some point in the past (Jordyn
-- Propst, Logan's reported case, included) before that fix existed. Any
-- round they raced BEFORE their drivers row existed still has zero
-- race_scores rows for them today; nothing about linking their cust_id
-- afterward retroactively recalculated those specific rounds.
--
-- This finds every round where a currently-rostered driver's cust_id has a
-- curated_race_results row but no matching race_scores row, and
-- recalculates that whole round (recalculate_race_scores() is a full,
-- idempotent recompute of every entrant in the round — same call Admin >
-- Seasons' Recalculate button already makes per round — so this is safe to
-- run even though it also recomputes everyone else already correctly
-- scored in the same round, not just the newly-fixed driver).
--
-- Deliberately not scoped to Jordyn Propst specifically: this is a generic
-- symptom of the same gap, so anyone else silently affected the same way
-- gets swept up in the same pass. A round failing to recalculate (no
-- ruleset assigned, standings locked, round not linked to a season, etc.)
-- is logged via RAISE NOTICE rather than aborting the rest — check the
-- migration's own output for any "Failed to recalculate" lines and, if any
-- show up, resolve whatever that round is missing and re-run
-- recalculate_race_scores(<subsession_id>) for it by hand (or unlock the
-- season and use Admin > Seasons' Recalculate).
do $$
declare
  v_subsession_id bigint;
  v_count integer := 0;
  v_failed integer := 0;
begin
  for v_subsession_id in
    select distinct rr.subsession_id
    from public.curated_race_results rr
    join public.drivers d on d.iracing_cust_id = rr.cust_id
    join public.curated_rounds cr on cr.subsession_id = rr.subsession_id
    where cr.status = 'official'
      and not exists (
        select 1 from public.race_scores rs
        where rs.subsession_id = rr.subsession_id and rs.driver_id = d.id
      )
  loop
    begin
      perform public.recalculate_race_scores(v_subsession_id);
      v_count := v_count + 1;
    exception when others then
      v_failed := v_failed + 1;
      raise notice 'Failed to recalculate subsession %: %', v_subsession_id, sqlerrm;
    end;
  end loop;

  raise notice 'Backfill complete: % round(s) recalculated, % failed.', v_count, v_failed;
end $$;
