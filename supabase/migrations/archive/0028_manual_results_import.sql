-- Alpha Touring Challenge — manual Race Results CSV import
--
-- DELIBERATE, LOGAN-APPROVED EXCEPTION to this repo's long-standing rule
-- (see 0004_champions.sql, 0014_penalties.sql, 0018_curated_rounds_layout.sql)
-- of never writing into curated_rounds / curated_race_results / race_scores
-- — the three tables an external iRacing-results import pipeline otherwise
-- owns exclusively. Asked directly ("write into the pipeline's own tables,
-- or keep results app-owned and separate?"), Logan chose writing into the
-- pipeline's tables: fastest to build, and every downstream feature
-- (standings, career stats, news recaps, "Race Recaps at this Layout")
-- picks up an imported round automatically since it's just a normal row in
-- the same tables a real pipeline import would have produced.
--
-- Collision safety: every manually-imported round is assigned a NEGATIVE
-- subsession_id (see src/lib/raceResultsImport.ts's nextSyntheticSubsessionId)
-- — real iRacing subsession_ids are always positive, so a real pipeline
-- import can mathematically never collide with, or overwrite, a manually
-- imported round. curated_qualifying is deliberately left untouched (no
-- write policy added) — nothing in this app reads it, so the CSV importer
-- has no reason to write it.
--
-- manual_result_imports (below) maps an admin-chosen `import_key` (typed
-- once into the CSV, e.g. "exh-2026-08-09-daytona") to the synthetic
-- subsession_id it was assigned, so re-uploading a corrected CSV with the
-- same key updates that exact round in place instead of creating a
-- duplicate — see src/lib/raceResultsImport.ts.

drop policy if exists "admin write curated_rounds" on curated_rounds;
create policy "admin write curated_rounds" on curated_rounds for insert with check (is_admin());
drop policy if exists "admin update curated_rounds" on curated_rounds;
create policy "admin update curated_rounds" on curated_rounds for update using (is_admin());
drop policy if exists "admin delete curated_rounds" on curated_rounds;
create policy "admin delete curated_rounds" on curated_rounds for delete using (is_admin());

drop policy if exists "admin write curated_race_results" on curated_race_results;
create policy "admin write curated_race_results" on curated_race_results for insert with check (is_admin());
drop policy if exists "admin update curated_race_results" on curated_race_results;
create policy "admin update curated_race_results" on curated_race_results for update using (is_admin());
drop policy if exists "admin delete curated_race_results" on curated_race_results;
create policy "admin delete curated_race_results" on curated_race_results for delete using (is_admin());

drop policy if exists "admin write race_scores" on race_scores;
create policy "admin write race_scores" on race_scores for insert with check (is_admin());
drop policy if exists "admin update race_scores" on race_scores;
create policy "admin update race_scores" on race_scores for update using (is_admin());
drop policy if exists "admin delete race_scores" on race_scores;
create policy "admin delete race_scores" on race_scores for delete using (is_admin());

-- ---------------------------------------------------------------------------
-- import_key -> synthetic subsession_id, so a re-uploaded CSV can find and
-- replace its own previously-imported round instead of duplicating it.
-- App-owned (like round_overrides/penalties) — purely bookkeeping for the
-- importer itself, not read by any public page.
-- ---------------------------------------------------------------------------

create table if not exists manual_result_imports (
  import_key text primary key,
  subsession_id bigint not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists manual_result_imports_set_updated_at on manual_result_imports;
create trigger manual_result_imports_set_updated_at before update on manual_result_imports
  for each row execute function set_updated_at();

alter table manual_result_imports enable row level security;

drop policy if exists "admin read manual_result_imports" on manual_result_imports;
create policy "admin read manual_result_imports" on manual_result_imports for select using (is_admin());
drop policy if exists "admin write manual_result_imports" on manual_result_imports;
create policy "admin write manual_result_imports" on manual_result_imports for insert with check (is_admin());
drop policy if exists "admin update manual_result_imports" on manual_result_imports;
create policy "admin update manual_result_imports" on manual_result_imports for update using (is_admin());
drop policy if exists "admin delete manual_result_imports" on manual_result_imports;
create policy "admin delete manual_result_imports" on manual_result_imports for delete using (is_admin());
