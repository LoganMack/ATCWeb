-- Alpha Touring Challenge — driver_season_car_numbers
--
-- drivers.car_number is a single CURRENT number — exactly the same problem
-- driver_season_classes (0037_class_and_scoring_fixes.sql) was built to fix
-- for class, except worse here: the manual Race Results CSV importer
-- (src/lib/raceResultsImport.ts) and the Incident Report's CSV importer
-- (src/pages/results/[subsessionId]/incidents.astro) both resolve a CSV
-- row's `driver_car_number` to a driver_id by matching against the
-- driver's CURRENT car_number. If a driver's number has since changed, or
-- was cleared entirely, that match silently fails — the row is skipped,
-- the driver never shows up in that round's results (and its class-relative
-- positions compress upward around the gap, looking exactly like a
-- phantom penalty), and they're unselectable in that round's Incident
-- Report driver dropdowns (which are themselves populated from the round's
-- results).
--
-- This is the optional per-season override, mirroring driver_season_classes
-- exactly: a season with no row here falls back to drivers.car_number (the
-- driver's current number), so nothing changes for a driver who's never had
-- their number change. Both importers above should prefer this table (for
-- the round's own season) over the driver's current number when resolving a
-- CSV row's car number to a driver.
--
-- unique (season_id, car_number) is the hard backstop for "no two drivers
-- share a number in the same season" — the admin driver-edit page also
-- validates this up front (checking every driver's resolved number for that
-- season, including those with no override row) so admins see a clear error
-- instead of a raw constraint violation, but the constraint is what actually
-- guarantees it.
create table public.driver_season_car_numbers (
  driver_id  uuid    not null references public.drivers(id) on delete cascade,
  season_id  uuid    not null references public.seasons(id) on delete cascade,
  car_number integer not null check (car_number >= 0),
  created_at timestamptz not null default now(),
  primary key (driver_id, season_id),
  unique (season_id, car_number)
);

comment on table public.driver_season_car_numbers is
  'Optional override of which car number a driver used in a given season — falls back to drivers.car_number (their current number) when no row exists for a driver+season. Needed because a driver''s number can change over their career; the manual Race Results and Incident Report CSV importers resolve a CSV row''s driver_car_number to a driver_id via this table (for the round''s season) before falling back to drivers.car_number, so a driver whose number has since changed or been cleared still resolves correctly for past rounds.';

alter table public.driver_season_car_numbers enable row level security;

create policy "public read" on public.driver_season_car_numbers for select using (true);
create policy "admin write driver_season_car_numbers" on public.driver_season_car_numbers for insert with check (is_admin());
create policy "admin update driver_season_car_numbers" on public.driver_season_car_numbers for update using (is_admin());
create policy "admin delete driver_season_car_numbers" on public.driver_season_car_numbers for delete using (is_admin());
