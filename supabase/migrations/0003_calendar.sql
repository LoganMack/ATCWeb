-- Alpha Touring Challenge — race calendar (circuits + events)
--
-- `circuits` is a reusable reference table (a track gets raced across many
-- seasons) so its logo/name only need to be entered once. `layout` lives on
-- the event itself, not the circuit, since the same circuit can be run in a
-- different configuration from one event to the next (e.g. full course vs.
-- a boot/chicane layout).
--
-- `events` is one row per race weekend. All of a weekend's sessions share
-- a single `event_date`, with each session storing its own time-of-day —
-- a deliberate simplification over five independent timestamps, since every
-- ATC race weekend runs all its sessions on the same calendar day, and one
-- date field plus plain per-session times is much easier for an admin to
-- fill in correctly.

create table circuits (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  logo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger circuits_set_updated_at before update on circuits
  for each row execute function set_updated_at();

alter table circuits enable row level security;
create policy "public read" on circuits for select using (true);
create policy "admin write circuits" on circuits for insert with check (is_admin());
create policy "admin update circuits" on circuits for update using (is_admin());
create policy "admin delete circuits" on circuits for delete using (is_admin());

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------

create table events (
  id uuid primary key default gen_random_uuid(),
  circuit_id uuid not null references circuits(id) on delete restrict,
  layout text,
  event_date date not null,

  format text not null default 'sprint' check (format in ('endurance', 'sprint', 'special')),
  fuel_limit_pct int,
  results_url text,

  practice_start_time time,
  practice_minutes int,
  practice_weather text check (practice_weather in ('dry', 'mixed', 'wet')),

  qualifying_start_time time,
  qualifying_minutes int,
  qualifying_laps int,
  qualifying_weather text check (qualifying_weather in ('dry', 'mixed', 'wet')),

  -- Race 1 is the only session that's always assumed to happen.
  race1_start_time time not null,
  race1_laps int,
  race1_weather text check (race1_weather in ('dry', 'mixed', 'wet')),

  race2_start_time time,
  race2_laps int,
  race2_weather text check (race2_weather in ('dry', 'mixed', 'wet')),

  race3_start_time time,
  race3_laps int,
  race3_weather text check (race3_weather in ('dry', 'mixed', 'wet')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index events_date_idx on events (event_date);
create index events_circuit_idx on events (circuit_id);

create trigger events_set_updated_at before update on events
  for each row execute function set_updated_at();

alter table events enable row level security;
create policy "public read" on events for select using (true);
create policy "admin write events" on events for insert with check (is_admin());
create policy "admin update events" on events for update using (is_admin());
create policy "admin delete events" on events for delete using (is_admin());
