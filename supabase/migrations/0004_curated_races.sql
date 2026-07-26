-- Alpha Touring Challenge — curated races data model
--
-- Implements the races architecture agreed 2026-07-25 (see HANDOFF.md
-- "Races data model — agreed architecture"). Summary of the decisions this
-- migration encodes:
--
--   * We do NOT store iRacing's raw payload in the DB. iRacing is itself the
--     durable, re-fetchable archive, so mirroring its `cust_id`-laden blob here
--     was a redundant second copy AND the source of the anon-exposure hole.
--     The old out-of-band `races` table is therefore DROPPED, not RLS-gated.
--   * The upload server curates/trims on ingest and writes ONLY the curated
--     shape below (baseline positions from iRacing, penalties = 0), so a race
--     is publicly viewable the moment it lands.
--   * The web app's admin page owns penalty application + position recompute.
--     Penalties are first-class rows in the `penalties` table (audit trail +
--     applied/not-applied state), recorded in POINTS; the web app converts
--     points -> time. `curated_race_results.penalty_points` and
--     `adjusted_position` are the derived, applied results of those penalties.
--   * Ground truth for identity stays minimal and internal: `cust_id` lives on
--     the base results table but is NEVER exposed to anon — the public read path
--     goes through the `race_results` view, which omits it.
--
-- NOTE on 0003_security_fixes.sql: its `races`/`seasons` RLS blocks are made
-- obsolete by this migration (races is dropped; `seasons` is the legit 0001 app
-- table and should stay publicly readable). Only 0003's profile
-- role-escalation trigger remains relevant — apply that half.

-- ---------------------------------------------------------------------------
-- 0. Remove the legacy raw ingestion table
-- ---------------------------------------------------------------------------
-- `races` (336 rows) was created out-of-band via the SQL editor with no
-- migration; it is a raw iRacing dump we no longer keep. We drop it here and
-- let the new upload server repopulate the curated tables below from iRacing
-- (the re-fetchable source of truth), so nothing of value is lost. `seasons`
-- is the legitimate 0001 app table (empty, not drift) — do NOT drop it.

drop table if exists public.races cascade;

-- ---------------------------------------------------------------------------
-- 1. curated_races — one row per race (subsession)
-- ---------------------------------------------------------------------------
-- The display-ready header for a race. No personal data. Publicly readable.
-- Keyed by iRacing's own subsession_id so the upload server can upsert
-- idempotently and re-fetches are stable.

create table curated_races (
  subsession_id      bigint primary key,        -- iRacing subsession id (natural key)
  start_time         timestamptz not null,
  track_name         text not null,
  series_name        text,                       -- iRacing series ("Hosted iRacing" for hosted sessions)
  season_label       text,                       -- iRacing league_season_name shown until linked, e.g. "ATC1"
  season_id          uuid references seasons(id) on delete set null, -- link to the app's season, filled in later
  strength_of_field  int,
  num_drivers        int,
  -- provisional the instant the server ingests it; flips to final once a
  -- steward has reviewed and applied (or cleared) penalties on the admin page.
  status             text not null default 'provisional'
                       check (status in ('provisional', 'final')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index curated_races_start_time_idx on curated_races (start_time desc);
create index curated_races_season_idx on curated_races (season_id);

create trigger curated_races_set_updated_at before update on curated_races
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. curated_race_results — one row per driver per race
-- ---------------------------------------------------------------------------
-- POSITION CONVENTION (cross-repo contract): both `finish_position` and
-- `adjusted_position` are stored 1-based (P1 = winner). iRacing's API is
-- 0-based (winner = 0); the upload server adds 1 when curating. Keep this in
-- sync with the server.
--
-- PENALTY / RE-SORT MODEL (implemented in the web app, in TypeScript):
--   penalty_seconds    = penalty_points * <points->seconds mapping owned by the
--                          web app; NOT stored in the DB, so it can change /
--                          become per-season without a data migration>
--   effective_interval = interval_ten_thousandths + penalty_seconds * 10000
--   adjusted_position  = rank of the field by
--                          (laps_complete desc, effective_interval asc)
-- Penalties are recorded in POINTS (see the `penalties` table); the web app is
-- the only place that knows how many seconds a point is worth.
-- `interval_ten_thousandths` is iRacing's `interval` verbatim: ten-thousandths
-- of a second behind the class leader, or -1 when a lap or more down (hence
-- laps_complete is the primary sort key). The leader's interval is 0.

create table curated_race_results (
  id                        uuid primary key default gen_random_uuid(),
  subsession_id             bigint not null references curated_races(subsession_id) on delete cascade,

  -- INTERNAL identity — the iRacing customer id of every driver in the session.
  -- SOFT join key (both bigint), NOT a foreign key: results contain everyone
  -- who raced (guests / non-members), so no parent table holds every value.
  -- Attribution anchor is drivers.iracing_cust_id (added in 0005) — that maps a
  -- result to a rostered driver for standings / penalty-point accrual.
  -- (profiles.iracing_cust_id, from 0002, is the separate OAuth self-claim.)
  -- Never exposed to anon; the public `race_results` view below omits it.
  cust_id                   bigint not null,

  display_name              text not null,
  car_name                  text,
  car_class_name            text,

  finish_position           int not null,        -- 1-based, straight from iRacing (server +1)
  starting_position         int,                 -- 1-based; iRacing's -1 (no qual) -> null via the server
  laps_complete             int,
  interval_ten_thousandths  bigint,              -- iRacing `interval`; time basis for the re-sort
  incidents                 int,

  -- Admin-owned, derived on the web app days after the race. penalty_points is
  -- the APPLIED AGGREGATE: the sum of this driver's applied rows in the
  -- `penalties` table (section 2b), in points. A cache so the public view can
  -- read the effective penalty without touching the private penalties log; the
  -- web app converts points -> time when it recomputes adjusted_position.
  penalty_points            int not null default 0,
  adjusted_position         int,                 -- 1-based; null until a steward finalizes

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  -- One row per driver per race — the upload server's upsert target.
  unique (subsession_id, cust_id)
);

create index curated_race_results_subsession_idx on curated_race_results (subsession_id);
create index curated_race_results_cust_idx on curated_race_results (cust_id);

create trigger curated_race_results_set_updated_at before update on curated_race_results
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 2b. penalties — one row per steward decision against a driver in a race
-- ---------------------------------------------------------------------------
-- Optional and additive: a race may have zero penalties. This is the SOURCE OF
-- TRUTH for penalties; `curated_race_results.penalty_points` is a derived cache
-- of the applied rows here. Keeping penalties in their own table gives:
--   * an audit trail (who/why, multiple penalties per driver, kept even if
--     later reversed),
--   * a clean "applied vs not yet applied" distinction per penalty, so the
--     admin UI can show which races still have outstanding steward work.
--
-- A penalty is recorded in POINTS only. Those points drive two things, both
-- computed by the web app (the DB stores neither derived value as seconds):
--   * this race's position re-sort — the web app converts points -> a time
--     delta (it owns the mapping) and re-ranks the field,
--   * the driver's cumulative record — points accrue to
--     drivers.penalty_points / penalty_points_max (from 0001).
--
-- Admin-only, always: it holds the internal cust_id and free-text steward
-- reasons, so it is never exposed to anon (no public view). The public only
-- ever sees the *effect* via the race_results view.

create table penalties (
  id                uuid primary key default gen_random_uuid(),
  subsession_id     bigint not null,     -- the race (see composite FK below)
  cust_id           bigint not null,     -- the driver penalized

  penalty_points    int not null default 0,   -- the penalty currency; the web app converts to time for the re-sort and accrues it to drivers.penalty_points
  reason            text,                       -- steward note (optional)

  -- false = logged but not yet reflected in curated_race_results; flipping this
  -- to true is what the admin "apply" action does (then it recomputes the
  -- aggregate + adjusted_position for the affected race).
  applied           boolean not null default false,
  applied_at        timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- A penalty must map to a real result row (driver who actually raced). This
  -- composite FK also transitively guarantees the race exists (results ->
  -- curated_races), so no separate FK to curated_races is needed.
  foreign key (subsession_id, cust_id)
    references curated_race_results (subsession_id, cust_id) on delete cascade
);

create index penalties_subsession_idx on penalties (subsession_id);
create index penalties_cust_idx on penalties (cust_id);

create trigger penalties_set_updated_at before update on penalties
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Row Level Security
-- ---------------------------------------------------------------------------
-- curated_races: no personal data -> public read; admin writes. (The upload
-- server writes with the service-role key, which bypasses RLS entirely, so it
-- needs no policy.)

alter table curated_races enable row level security;

create policy "public read races" on curated_races for select using (true);
create policy "admin insert races" on curated_races for insert with check (is_admin());
create policy "admin update races" on curated_races for update using (is_admin());
create policy "admin delete races" on curated_races for delete using (is_admin());

-- curated_race_results: carries the internal cust_id, so the BASE table is
-- NOT anon-readable. Admins can read it in full (to link drivers and apply
-- penalties); the public reads the cust_id-free view in section 4.

alter table curated_race_results enable row level security;

create policy "admin read results" on curated_race_results for select using (is_admin());
create policy "admin insert results" on curated_race_results for insert with check (is_admin());
create policy "admin update results" on curated_race_results for update using (is_admin());
create policy "admin delete results" on curated_race_results for delete using (is_admin());

-- penalties: admin-only in every direction. Holds cust_id + steward reasons and
-- is never surfaced to the public (its effect shows up only via race_results).

alter table penalties enable row level security;

create policy "admin read penalties" on penalties for select using (is_admin());
create policy "admin insert penalties" on penalties for insert with check (is_admin());
create policy "admin update penalties" on penalties for update using (is_admin());
create policy "admin delete penalties" on penalties for delete using (is_admin());

-- ---------------------------------------------------------------------------
-- 4. Public projection — race_results view (omits cust_id)
-- ---------------------------------------------------------------------------
-- Anon/authenticated read curated results through this view, which exposes
-- every display column EXCEPT the internal cust_id. The view runs with its
-- owner's privileges (Postgres default: security_invoker = off), so it can
-- read the RLS-protected base table and serve all rows to the public — this
-- is the intended public projection, not an accidental leak.

create view race_results as
  select
    id,
    subsession_id,
    display_name,
    car_name,
    car_class_name,
    finish_position,
    starting_position,
    laps_complete,
    interval_ten_thousandths,
    incidents,
    penalty_points,
    adjusted_position,
    created_at,
    updated_at
  from curated_race_results;

grant select on race_results to anon, authenticated;
