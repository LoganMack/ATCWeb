-- One-time data fix, companion to 0067_ruleset_overhaul_and_bonuses.sql.
--
-- 0067 only changes what a FUTURE recalculate_race_scores() call produces —
-- the class-pole season-scoping fix and the four new bonus columns don't
-- retroactively touch any race_scores row already on file. This re-runs
-- recalculate_race_scores() for every official round so history actually
-- picks up the fix (confirmed against Logan's reported case: before this,
-- subsession 37324062/37445019/37565626 (ATC1) each had TWO drivers
-- credited with pole_bonus in the same race despite ATC1 only ever having
-- an Alpha class; after, exactly one per race, as expected).
--
-- Same idempotent, log-and-continue pattern as
-- 0061_backfill_missing_race_scores.sql — a round failing to recalculate is
-- logged via RAISE NOTICE rather than aborting the rest.
--
-- Expect 17 pre-existing failures here, all "Season <id> has no scoring
-- ruleset" — three non-championship seasons ("ATC4 Off-Season Fun Series",
-- "LCC1", "ATC Exhibitions") whose scoring_ruleset_id points at a ruleset
-- that's since been deleted. This is a pre-existing data-integrity gap, not
-- something this migration causes or fixes — confirmed the same error
-- occurs identically against the ORIGINAL (pre-0067) recalculate_race_scores
-- too. None of these are real championship seasons (see
-- isChampionshipSeason() in src/lib/results.ts), so nothing reads their
-- race_scores for standings/awards today, but flagging here in case that
-- ever changes: someone should either assign these seasons a real ruleset
-- or leave them permanently unscored on purpose.
do $$
declare
  v_subsession_id bigint;
  v_count integer := 0;
  v_failed integer := 0;
begin
  for v_subsession_id in
    select subsession_id from public.curated_rounds where status = 'official' order by start_time
  loop
    begin
      perform public.recalculate_race_scores(v_subsession_id);
      v_count := v_count + 1;
    exception when others then
      v_failed := v_failed + 1;
      raise notice 'Failed to recalculate subsession %: %', v_subsession_id, sqlerrm;
    end;
  end loop;

  raise notice 'Rescore complete: % round(s) recalculated, % failed.', v_count, v_failed;
end $$;
