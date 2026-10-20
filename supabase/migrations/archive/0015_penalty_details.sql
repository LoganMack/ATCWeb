-- Alpha Touring Challenge — penalty tweaks: warnings and involved cars
--
-- Two additions to the penalty system from 0014_penalties.sql:
--   1. is_warning — flags a logged penalty as "just a warning" rather than
--      (or alongside) a real penalty, so stewards can see when a driver has
--      been warned twice (rulebook offense "2 warnings" -> +1 PP).
--   2. penalty_involved_drivers — which other cars were part of the same
--      incident, a many-to-many join same shape as penalty_offense_links.

alter table penalties add column if not exists is_warning boolean not null default false;

create table if not exists penalty_involved_drivers (
  penalty_id uuid not null references penalties (id) on delete cascade,
  driver_id uuid not null references drivers (id) on delete cascade,
  primary key (penalty_id, driver_id)
);

alter table penalty_involved_drivers enable row level security;

drop policy if exists "public read" on penalty_involved_drivers;
create policy "public read" on penalty_involved_drivers for select using (true);
drop policy if exists "admin write penalty_involved_drivers" on penalty_involved_drivers;
create policy "admin write penalty_involved_drivers" on penalty_involved_drivers for insert with check (is_admin());
drop policy if exists "admin delete penalty_involved_drivers" on penalty_involved_drivers;
create policy "admin delete penalty_involved_drivers" on penalty_involved_drivers for delete using (is_admin());
