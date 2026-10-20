-- Adds a per-ruleset toggle controlling whether a season's drop-week
-- mechanic (see src/lib/results.ts's finalizeStandings/BASELINE_DROP_WEEKS)
-- is allowed to drop the final round of the season for driver standings.
--
-- Polarity (confirmed with Logan): can_drop_final_round = false (the
-- default) means the final round is PROTECTED — always counted, never one
-- of the worst-N dropped rounds. can_drop_final_round = true means the
-- final round is treated like any other round and can be dropped along
-- with the rest if it's among the driver's worst scores.
--
-- The drop-week mechanic itself lives entirely in TypeScript
-- (finalizeStandings/computeSeasonStandings/computeOverallSeasonStandings
-- in src/lib/results.ts) — this column is read via resolveSeasonRuleset()
-- there, not by recalculate_race_scores() or any other DB-side function.
alter table public.scoring_rulesets
  add column if not exists can_drop_final_round boolean not null default false;
