-- Index the unindexed foreign keys and give curated_practice_results a primary key (PERF-10).
--
-- What:
--   1. One plain btree index on each of the 7 referencing columns the Supabase performance
--      advisor lists as unindexed foreign keys.
--   2. A guard that stops the migration, naming the count, when curated_practice_results already
--      holds a repeated (subsession_id, cust_id) pair.
--   3. The primary key curated_practice_results_pkey on (subsession_id, cust_id), the same
--      round-plus-driver identity curated_qualifying already has.
--
-- Why: without an index, deleting or updating a referenced user or driver scans the whole
-- referencing table, and a table with no primary key cannot be addressed row by row and accepts
-- duplicates silently. The practice import already writes one row per driver per round.
--
-- Nothing is dropped or altered otherwise: race_scores_archive, the unused indexes and
-- curated_practice_results_subsession_id_idx stay as they are.
--
-- Plain (not CONCURRENTLY) indexes, because migrations run inside one transaction; these tables
-- are small, so the brief lock is harmless.
--
-- Undo: supabase/down/20261025120000_db_hygiene_indexes_and_practice_key.down.sql drops the
-- primary key and the 7 indexes.

-- 1. Foreign-key indexes -----------------------------------------------------------------------

create index if not exists incident_appeals_submitter_id_idx
  on public.incident_appeals using btree (submitter_id);

create index if not exists incident_report_review_drivers_driver_id_idx
  on public.incident_report_review_drivers using btree (driver_id);

create index if not exists incident_report_reviews_reviewer_id_idx
  on public.incident_report_reviews using btree (reviewer_id);

create index if not exists race_interviews_submitter_id_idx
  on public.race_interviews using btree (submitter_id);

create index if not exists round_penalties_created_by_idx
  on public.round_penalties using btree (created_by);

create index if not exists signup_requests_decided_by_idx
  on public.signup_requests using btree (decided_by);

create index if not exists signup_requests_driver_id_idx
  on public.signup_requests using btree (driver_id);

-- 2. Duplicate guard ---------------------------------------------------------------------------

-- Fails with a clear message instead of a bare unique-violation from the add constraint below.
do $$
declare
  v_duplicates bigint;
begin
  select count(*)
  into v_duplicates
  from (
    select 1
    from public.curated_practice_results
    group by subsession_id, cust_id
    having count(*) > 1
  ) d;

  if v_duplicates > 0 then
    raise exception
      'curated_practice_results has % repeated (subsession_id, cust_id) pair(s); remove the duplicates before adding the primary key',
      v_duplicates;
  end if;
end;
$$;

-- 3. Primary key -------------------------------------------------------------------------------

alter table public.curated_practice_results
  add constraint curated_practice_results_pkey primary key (subsession_id, cust_id);
