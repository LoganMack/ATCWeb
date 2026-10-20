-- Alpha Touring Challenge — round-level exhibition overrides
--
-- Season-level championship/exhibition classification needs no schema at
-- all: any season whose `name` doesn't match the "ATCxx" pattern (e.g.
-- "ATC17") is a non-points exhibition season, and that's derived purely
-- from the name in src/lib/results.ts's `isChampionshipSeason()`.
--
-- But an individual round *inside* an otherwise-real championship season
-- can also be a non-points exhibition — the concrete example that came up
-- is ATC17's April 6 first race, a pre-season exhibition run before that
-- season's points started counting. That needs somewhere to record the
-- flag, which is what this table is for. Like champion_photos (see
-- 0004_champions.sql), this table IS owned by this repo — but deliberately
-- does NOT alter curated_rounds itself (add a column there, say), since
-- that table is populated by the external iRacing-results import pipeline
-- and this repo's migrations must never touch the pipeline's own tables'
-- shape. round_overrides intentionally has no FK to curated_rounds for the
-- same reason — just a plain subsession_id key the app code joins on.
create table if not exists round_overrides (
  subsession_id bigint primary key,
  is_exhibition boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists round_overrides_set_updated_at on round_overrides;
create trigger round_overrides_set_updated_at before update on round_overrides
  for each row execute function set_updated_at();

alter table round_overrides enable row level security;

drop policy if exists "public read" on round_overrides;
create policy "public read" on round_overrides for select using (true);

drop policy if exists "admin write round_overrides" on round_overrides;
create policy "admin write round_overrides" on round_overrides for insert with check (is_admin());

drop policy if exists "admin update round_overrides" on round_overrides;
create policy "admin update round_overrides" on round_overrides for update using (is_admin());

drop policy if exists "admin delete round_overrides" on round_overrides;
create policy "admin delete round_overrides" on round_overrides for delete using (is_admin());

-- ---------------------------------------------------------------------------
-- Codifies a manual fix applied directly in the Supabase SQL editor while
-- diagnosing "permission denied for table drivers" (42501) on the Champions
-- page: `drivers.iracing_cust_id` was added to `drivers` outside this repo's
-- migrations, and column-scoped grants aren't extended automatically to a
-- new column — so anon could read the rest of `drivers` (granted back in
-- 0001_init.sql) but not this one column. Folding the already-confirmed-
-- working fix in here so a fresh database setup doesn't hit the same wall.
-- Safe to re-run.
-- ---------------------------------------------------------------------------
grant select on public.drivers to anon;
