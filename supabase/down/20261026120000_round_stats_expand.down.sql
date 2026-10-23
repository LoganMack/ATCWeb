-- Down script for 20261026120000_round_stats_expand.sql.
--
-- Drops only what the expand migration added, in reverse order: the queueing triggers on the input
-- tables, the drain trigger, the functions, then the tables round_driver_stats, round_team_stats,
-- round_penalty_points, round_stats_issues and private.round_stats_pending (their policies, guard
-- triggers and indexes go with them). Nothing else changes. The stored rows are derived data:
-- rebuild_season_stats fills them again if the migration is applied again.

drop trigger if exists round_stats_on_curated_rounds_update on public.curated_rounds;
drop trigger if exists round_stats_on_drivers_insert on public.drivers;
drop trigger if exists round_stats_on_drivers_update on public.drivers;
drop trigger if exists round_stats_on_drivers_delete on public.drivers;
drop trigger if exists round_stats_on_curated_race_results_insert on public.curated_race_results;
drop trigger if exists round_stats_on_curated_race_results_update on public.curated_race_results;
drop trigger if exists round_stats_on_curated_race_results_delete on public.curated_race_results;
drop trigger if exists round_stats_on_round_incident_status_insert on public.round_incident_status;
drop trigger if exists round_stats_on_round_incident_status_update on public.round_incident_status;
drop trigger if exists round_stats_on_round_incident_status_delete on public.round_incident_status;
drop trigger if exists round_stats_on_penalties_insert on public.penalties;
drop trigger if exists round_stats_on_penalties_update on public.penalties;
drop trigger if exists round_stats_on_penalties_delete on public.penalties;
drop trigger if exists round_stats_on_race_score_results_insert on public.race_score_results;
drop trigger if exists round_stats_on_race_score_results_update on public.race_score_results;
drop trigger if exists round_stats_on_race_score_results_delete on public.race_score_results;
drop trigger if exists round_stats_drain on private.round_stats_pending;

drop function if exists private.round_stats_on_curated_rounds();
drop function if exists private.round_stats_on_drivers();
drop function if exists private.round_stats_on_curated_race_results();
drop function if exists private.round_stats_on_round_incident_status();
drop function if exists private.round_stats_on_penalties();
drop function if exists private.round_stats_on_race_score_results();
drop function if exists private.round_stats_drain();
drop function if exists private.queue_round_stats(bigint[]);
drop function if exists public.rebuild_season_stats(uuid);
drop function if exists private.refresh_round_stats(bigint[]);
drop function if exists private.record_round_stats_issue(bigint, uuid, text);
drop function if exists private.build_round_stats(bigint);

drop table if exists private.round_stats_pending;
drop table if exists public.round_stats_issues;
drop table if exists public.round_penalty_points;
drop table if exists public.round_team_stats;
drop table if exists public.round_driver_stats;

drop function if exists private.round_stats_guard();
