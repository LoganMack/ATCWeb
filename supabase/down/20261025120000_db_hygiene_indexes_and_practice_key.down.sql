-- Down script for 20261025120000_db_hygiene_indexes_and_practice_key.sql.
--
-- Removes exactly what the migration added, in reverse order: the primary key on
-- curated_practice_results, then the 7 foreign-key indexes. Rows written in the meantime stay;
-- curated_practice_results_subsession_id_idx was never touched and stays too.

alter table public.curated_practice_results
  drop constraint if exists curated_practice_results_pkey;

drop index if exists public.signup_requests_driver_id_idx;
drop index if exists public.signup_requests_decided_by_idx;
drop index if exists public.round_penalties_created_by_idx;
drop index if exists public.race_interviews_submitter_id_idx;
drop index if exists public.incident_report_reviews_reviewer_id_idx;
drop index if exists public.incident_report_review_drivers_driver_id_idx;
drop index if exists public.incident_appeals_submitter_id_idx;
