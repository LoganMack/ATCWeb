-- Alpha Touring Challenge — round penalties
--
-- Penalties that belong to a whole round rather than one race, logged from
-- the Round Penalties table on the round's Incident Report. Mostly the ones
-- the rulebook's PP Penalties table attaches to a driver's PP total for the
-- round (qualifying ban at 4PP, pit-lane start at 5-6PP, race ban at 7PP) and
-- the 1-round ban for reaching the season PP limit — none of which can be
-- applied to a race that's already been run, so they're served at a later
-- round. `served_subsession_id` records where: null means still owed, and
-- stewards see every owed penalty on each later round's report until it's
-- marked served (rulebook: final-round penalties can carry into the next
-- season, so this isn't limited to one season).
--
-- Record-keeping only: nothing here changes results, points or PP. Anything
-- that does (time, points deductions) is still logged as a normal incident.

create table if not exists round_penalties (
  id uuid primary key default gen_random_uuid(),
  -- The round it was earned in.
  subsession_id bigint not null,
  driver_id uuid not null references drivers (id) on delete cascade,
  kind text not null check (kind in ('qualifying_ban', 'pit_lane_start', 'race_ban', 'round_ban', 'other')),
  note text check (note is null or length(note) <= 500),
  -- The round it was served at; null while still owed.
  served_subsession_id bigint,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 'other' needs a note to say what it is.
  check (kind <> 'other' or note is not null)
);

create index if not exists round_penalties_subsession_idx on round_penalties (subsession_id);
create index if not exists round_penalties_owed_idx on round_penalties (subsession_id) where served_subsession_id is null;
create index if not exists round_penalties_driver_idx on round_penalties (driver_id);

alter table round_penalties enable row level security;

drop policy if exists "public read round_penalties" on round_penalties;
create policy "public read round_penalties" on round_penalties for select using (true);

-- (select ...) so is_admin() runs once per statement, not once per row (0103).
drop policy if exists "admin insert round_penalties" on round_penalties;
create policy "admin insert round_penalties" on round_penalties
  for insert with check ((select public.is_admin()));
drop policy if exists "admin update round_penalties" on round_penalties;
create policy "admin update round_penalties" on round_penalties
  for update using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "admin delete round_penalties" on round_penalties;
create policy "admin delete round_penalties" on round_penalties
  for delete using ((select public.is_admin()));
