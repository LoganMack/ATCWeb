-- Down script for 20261021120000_race_score_results_expand.sql.
--
-- Drops only what the expand migration added: the scoring triggers on the input tables, the
-- public view, score_round, score_round_preview, rescore_season, the private helpers, and the
-- tables race_score_results, scoring_issues and scoring_settings. race_scores,
-- recalculate_race_scores() and race_scores_public were never touched, so nothing else changes.
-- The rows in race_score_results are derived data: score_round rebuilds them if the migration is
-- applied again.

drop trigger if exists scoring_on_penalties_insert on public.penalties;
drop trigger if exists scoring_on_penalties_update on public.penalties;
drop trigger if exists scoring_on_penalties_delete on public.penalties;
drop trigger if exists scoring_on_curated_rounds_insert on public.curated_rounds;
drop trigger if exists scoring_on_curated_rounds_update on public.curated_rounds;
drop trigger if exists scoring_on_curated_rounds_delete on public.curated_rounds;
drop trigger if exists scoring_on_curated_race_results_insert on public.curated_race_results;
drop trigger if exists scoring_on_curated_race_results_update on public.curated_race_results;
drop trigger if exists scoring_on_curated_race_results_delete on public.curated_race_results;
drop trigger if exists scoring_on_curated_qualifying_insert on public.curated_qualifying;
drop trigger if exists scoring_on_curated_qualifying_update on public.curated_qualifying;
drop trigger if exists scoring_on_curated_qualifying_delete on public.curated_qualifying;
drop trigger if exists scoring_on_drivers_insert on public.drivers;
drop trigger if exists scoring_on_drivers_update on public.drivers;
drop trigger if exists scoring_on_drivers_delete on public.drivers;
drop trigger if exists scoring_on_driver_season_classes_insert on public.driver_season_classes;
drop trigger if exists scoring_on_driver_season_classes_update on public.driver_season_classes;
drop trigger if exists scoring_on_driver_season_classes_delete on public.driver_season_classes;
drop trigger if exists scoring_on_team_rosters_insert on public.team_rosters;
drop trigger if exists scoring_on_team_rosters_update on public.team_rosters;
drop trigger if exists scoring_on_team_rosters_delete on public.team_rosters;
drop trigger if exists scoring_on_seasons_insert on public.seasons;
drop trigger if exists scoring_on_seasons_update on public.seasons;
drop trigger if exists scoring_on_seasons_delete on public.seasons;
drop trigger if exists scoring_on_scoring_rulesets_insert on public.scoring_rulesets;
drop trigger if exists scoring_on_scoring_rulesets_update on public.scoring_rulesets;
drop trigger if exists scoring_on_scoring_rulesets_delete on public.scoring_rulesets;
drop trigger if exists scoring_on_driver_classes_insert on public.driver_classes;
drop trigger if exists scoring_on_driver_classes_update on public.driver_classes;
drop trigger if exists scoring_on_driver_classes_delete on public.driver_classes;

drop view if exists public.race_score_results_public;

drop function if exists public.rescore_season(uuid);
drop function if exists public.score_round_preview(bigint, jsonb);
drop function if exists public.score_round(bigint);

drop function if exists private.scoring_on_penalties();
drop function if exists private.scoring_on_curated_rounds();
drop function if exists private.scoring_on_curated_race_results();
drop function if exists private.scoring_on_curated_qualifying();
drop function if exists private.scoring_on_drivers();
drop function if exists private.scoring_on_driver_season_classes();
drop function if exists private.scoring_on_team_rosters();
drop function if exists private.scoring_on_seasons();
drop function if exists private.scoring_on_scoring_rulesets();
drop function if exists private.scoring_on_driver_classes();
drop function if exists private.scoring_rounds_for_driver_seasons(uuid[], uuid[]);
drop function if exists private.scoring_rescore(bigint[]);
drop function if exists private.scoring_record_issue(bigint, uuid, text);
drop function if exists private.scoring_compute(bigint, jsonb);
drop function if exists private.scoring_ts_order(integer[], numeric[], boolean[], integer[]);
drop function if exists private.scoring_ts_compare(integer, numeric, boolean, integer, integer, numeric, boolean, integer);
drop function if exists private.scoring_class_points(jsonb, text, integer, text, integer);
drop function if exists private.scoring_finish_points(jsonb, text, integer, boolean, integer, boolean);
drop function if exists private.scoring_unscorable_reason(bigint);
drop function if exists private.scoring_triggers_enabled();
drop function if exists private.scoring_switch_names();

drop table if exists public.race_score_results;
drop function if exists private.race_score_results_guard();
drop table if exists public.scoring_issues;
drop table if exists public.scoring_settings;
