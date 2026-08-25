-- Fixes the "canceling statement due to statement timeout" (Postgres error
-- 57014) Logan hit running Admin > Drivers > "Sync Statuses" (which calls
-- sync_driver_statuses() and sync_rookie_status() via RPC — see
-- syncDriverStatuses()/syncRookieStatus() in src/lib/supabase.ts and the
-- intent === 'sync-statuses' handler in src/pages/admin/drivers/index.astro).
--
-- ROOT CAUSE
--
-- driver_last_race (0039/0040_inactivity_90d_or_12_rounds.sql) computes
-- rounds_since_last_race with a scalar subquery that runs once per driver row:
--
--   select count(*) from curated_rounds cr2
--   where cr2.status = 'official' and cr2.start_time > lr.last_race_at
--
-- sync_driver_statuses() (0063_driver_never_raced_inactivity.sql) added a
-- second, near-identical correlated subquery for never-raced drivers, keyed
-- off d.sign_up_date instead of last_race_at. Both filter curated_rounds on
-- (status, start_time), and no migration in this repo has ever added a
-- supporting index for that filter — curated_rounds is owned and populated by
-- an external iRacing-results import pipeline, not by this repo (see
-- 0004_champions.sql's header comment), so it was never covered by any
-- create-table/create-index migration here. Every one of those per-driver
-- subquery evaluations has therefore been a full sequential scan of
-- curated_rounds. On top of that, sync_driver_statuses() references the
-- driver_last_race view from three separate UPDATE statements, and a plain
-- (non-materialized) view is recomputed from scratch each time it's
-- referenced — so one click of "Sync Statuses" does roughly
-- (drivers x curated_rounds rows x 3) work. That cost only grows as ATC
-- accumulates more seasons/rounds, which matches "this used to work and now
-- times out."
--
-- FIX
--
-- Add the missing supporting index so each of those subqueries becomes a
-- fast index range scan instead of a full table scan. `if not exists` since
-- curated_rounds isn't a table this repo created — we can't directly confirm
-- via a live index inspection (Supabase MCP access is unavailable while
-- writing this migration) whether the external pipeline already added an
-- equivalent index, so this is written to be a safe no-op if one already
-- exists. A partial index (only 'official' rows, which is the only status
-- either subquery ever filters on) keeps it small; ordering by start_time
-- lets Postgres satisfy the `> <reference date>` range directly from the
-- index.
create index if not exists curated_rounds_official_start_time_idx
  on public.curated_rounds (start_time)
  where status = 'official';

-- Belt-and-suspenders: driver_last_race's own join (drivers ->
-- curated_race_results on cust_id -> curated_rounds on subsession_id) should
-- already be supported by an index from 0004_curated_races.sql, but since
-- curated_race_results is also owned by the external pipeline we can't
-- directly confirm that index still exists on the live table, so it's
-- re-asserted here too. Cheap no-op if already present.
create index if not exists curated_race_results_cust_idx
  on public.curated_race_results (cust_id);

-- Make sure the query planner picks up the new indexes immediately rather
-- than waiting for autovacuum's next pass — otherwise the very next "Sync
-- Statuses" click could still get a stale plan.
analyze public.curated_rounds;
analyze public.curated_race_results;

-- NOTE for Logan: this targets sync_driver_statuses(), which is the far more
-- likely culprit (it's the one with the correlated subquery against a
-- growing table, evaluated 3x per call). sync_rookie_status() groups
-- driver_round_totals by driver/season instead — a different, also
-- externally-owned view — and doesn't share this exact pattern. If "Sync
-- Statuses" still times out after this migration, that's the next place to
-- look; let me know and I'll dig into driver_round_totals next.
