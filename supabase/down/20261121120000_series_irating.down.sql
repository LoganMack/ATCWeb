-- Undoes 20261121120000_series_irating.sql: drops the Series iRating views, functions, triggers and tables in
-- reverse order. Nothing that existed before changes; the stored ratings are lost and come back by
-- re-applying the migration, whose backfill rates every race again.

drop view if exists public.series_rating_history_shown;
drop view if exists public.series_ratings_shown;

drop trigger if exists rating_on_round_incident_status_delete on public.round_incident_status;
drop trigger if exists rating_on_round_incident_status_update on public.round_incident_status;
drop trigger if exists rating_on_round_incident_status_insert on public.round_incident_status;
drop trigger if exists rating_on_round_deleted on public.curated_rounds;
drop trigger if exists rating_on_round_moved on public.curated_rounds;
drop trigger if exists rating_on_race_score_results_delete on public.race_score_results;
drop trigger if exists rating_on_race_score_results_update on public.race_score_results;
drop trigger if exists rating_on_race_score_results_insert on public.race_score_results;
drop trigger if exists rating_drain on private.rating_queue;

drop function if exists public.rating_rebuild();
drop function if exists public.rating_process_pending();
drop function if exists private.rating_drain();
drop function if exists private.rating_on_round_incident_status();
drop function if exists private.rating_on_round_deleted();
drop function if exists private.rating_on_round_moved();
drop function if exists private.rating_on_race_score_results();
drop function if exists private.rating_enqueue(timestamptz);
drop function if exists private.rating_record_error(text);
drop function if exists private.rating_recompute(timestamptz);
drop function if exists private.rating_write_summaries(text[]);
drop function if exists private.rating_rate_race(bigint, integer, uuid, timestamptz, boolean);
drop function if exists private.rating_race_count(timestamptz, integer);
drop function if exists private.rating_lock_key();
drop function if exists private.rating_race(double precision[], integer[]);
drop function if exists private.rating_chance(double precision, double precision);

drop table if exists private.rating_state;
drop table if exists private.rating_queue;
drop table if exists private.rating_summary;
drop table if exists private.rating_steps;
