-- Alpha Touring Challenge — post-race penalties (rulebook 18.3, section 5 "Stewarding")
--
-- App-owned, like round_overrides/race_links — curated_race_results and
-- race_scores belong to the external iRacing-results import pipeline (see
-- src/lib/results.ts's header comment) and could be silently overwritten by
-- a re-import, so penalties are never written into those tables. Instead
-- this repo keeps its own record of every penalty issued, and the app
-- computes the resulting position/points adjustments on top of the imported
-- data at read time (see src/lib/penalties.ts) — a re-import can't lose
-- penalty history this way.

-- ---------------------------------------------------------------------------
-- Configurable offense list — the rulebook's "Post-Race Penalties" table.
-- ---------------------------------------------------------------------------

create table if not exists penalty_offenses (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  -- Free text, not a strict number — several rows in the rulebook's table
  -- are a range or an "or" choice (e.g. "+1-4 PP", "+1 Warning or +1 PP")
  -- that a single integer can't represent. Shown next to the offense in the
  -- penalty dialog's dropdown as a reference for the steward; the actual PP
  -- awarded for a specific penalty is always a separate, manually-entered
  -- number (see penalties.penalty_points below) — never auto-derived from
  -- this.
  reference_points text,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

insert into penalty_offenses (name, reference_points, sort_order) values
  ('At fault for incident', '1-4', 1),
  ('Lap 1 incident', '1', 2),
  ('At fault while in dangerous condition', '1', 3),
  ('At fault under blue flags', '1', 4),
  ('Unsafe rejoin / no brakes held', 'Warning or 1', 5),
  ('Blocking', 'Warning or 1', 6),
  ('Impeding under blue flags', 'Warning or 1', 7),
  ('Unfair advantage gained', 'Warning or 1', 8),
  ('At fault for contact in post-race cooldown', 'Warning', 9),
  ('Voice and/or text chat abuse', 'Warning or 1', 10),
  ('2 warnings', '1', 11),
  ('Unsportsmanlike conduct', 'Warning or 1-8', 12),
  ('Failure to serve penalty correctly', 'Warning or 1-8', 13),
  ('Deliberate wrecking or retaliation', 'Up to DSQ', 14)
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- Penalties themselves — one row per steward decision against one driver in
-- one specific race (rule 66: "Penalties are applied to the results of the
-- race they occurred in").
-- ---------------------------------------------------------------------------

create table if not exists penalties (
  id uuid primary key default gen_random_uuid(),
  subsession_id bigint not null,
  race_number integer not null,
  driver_id uuid not null references drivers (id) on delete cascade,
  incident_number text,
  lap integer,
  description text,
  time_penalty_seconds numeric,
  points_penalty integer not null default 0,
  penalty_points integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists penalties_race_idx on penalties (subsession_id, race_number);
create index if not exists penalties_driver_idx on penalties (driver_id);

drop trigger if exists penalties_set_updated_at on penalties;
create trigger penalties_set_updated_at before update on penalties
  for each row execute function set_updated_at();

create table if not exists penalty_offense_links (
  penalty_id uuid not null references penalties (id) on delete cascade,
  offense_id uuid not null references penalty_offenses (id) on delete restrict,
  primary key (penalty_id, offense_id)
);

alter table penalty_offenses enable row level security;
alter table penalties enable row level security;
alter table penalty_offense_links enable row level security;

drop policy if exists "public read" on penalty_offenses;
create policy "public read" on penalty_offenses for select using (true);
drop policy if exists "admin write penalty_offenses" on penalty_offenses;
create policy "admin write penalty_offenses" on penalty_offenses for insert with check (is_admin());
drop policy if exists "admin update penalty_offenses" on penalty_offenses;
create policy "admin update penalty_offenses" on penalty_offenses for update using (is_admin());
drop policy if exists "admin delete penalty_offenses" on penalty_offenses;
create policy "admin delete penalty_offenses" on penalty_offenses for delete using (is_admin());

drop policy if exists "public read" on penalties;
create policy "public read" on penalties for select using (true);
drop policy if exists "admin write penalties" on penalties;
create policy "admin write penalties" on penalties for insert with check (is_admin());
drop policy if exists "admin update penalties" on penalties;
create policy "admin update penalties" on penalties for update using (is_admin());
drop policy if exists "admin delete penalties" on penalties;
create policy "admin delete penalties" on penalties for delete using (is_admin());

drop policy if exists "public read" on penalty_offense_links;
create policy "public read" on penalty_offense_links for select using (true);
drop policy if exists "admin write penalty_offense_links" on penalty_offense_links;
create policy "admin write penalty_offense_links" on penalty_offense_links for insert with check (is_admin());
drop policy if exists "admin delete penalty_offense_links" on penalty_offense_links;
create policy "admin delete penalty_offense_links" on penalty_offense_links for delete using (is_admin());

-- ---------------------------------------------------------------------------
-- Incident report link — a 4th per-race external link alongside iRacing
-- results / replay / broadcast (see 0007_race_links.sql).
-- ---------------------------------------------------------------------------

alter table race_links add column if not exists incident_report_url text;

-- ---------------------------------------------------------------------------
-- Probation (rules 57-62). drivers.penalty_points/penalty_points_max already
-- existed (0001_init.sql, default max 11 — matches rule 57's season limit)
-- and keep being the running PP tally. These two new columns track whether
-- a driver is currently serving the probation triggered by hitting that
-- limit, and when it started — probation lasts 4 rounds or 45 days from
-- this date, whichever is longer (computed at read time in
-- src/lib/penalties.ts's isOnProbationNow(), not stored, since "4 rounds"
-- depends on the calendar, not a fixed date).
-- ---------------------------------------------------------------------------

alter table drivers add column if not exists on_probation boolean not null default false;
alter table drivers add column if not exists probation_started_at date;
