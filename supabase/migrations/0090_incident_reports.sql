-- Alpha Touring Challenge — driver-submitted incident reports
--
-- Anyone (signed in or, per 0091, not) can report an incident from a round's results page
-- (src/pages/results/[subsessionId].astro) for 24 hours after the race is
-- considered over (see src/lib/incidentReports.ts for the window math).
-- Reports are a queue for stewards, NOT penalties: they live in their own
-- table so unreviewed/dismissed reports never touch scoring or the public
-- incident list. Stewards see them on the round's Incident Report page and
-- can turn one into a real logged incident (or dismiss it).
--
-- The reporting WINDOW itself is enforced in the app (it depends on the
-- attached event's schedule); RLS here only guarantees a user can insert
-- reports as themselves and read their own, and that only admins can review.

create table if not exists incident_reports (
  id uuid primary key default gen_random_uuid(),
  subsession_id bigint not null,
  -- Same encoding as the Add Incident dialog: 'race:N' | 'qualifying:0' | 'practice:0'.
  session text not null,
  lap integer not null check (lap >= 0),
  turn text not null,
  description text,
  reporter_id uuid not null references auth.users (id) on delete cascade,
  reporter_name text,
  status text not null default 'open' check (status in ('open', 'logged', 'dismissed')),
  created_at timestamptz not null default now()
);

create index if not exists incident_reports_subsession_idx on incident_reports (subsession_id);
create index if not exists incident_reports_reporter_idx on incident_reports (reporter_id);

create table if not exists incident_report_drivers (
  report_id uuid not null references incident_reports (id) on delete cascade,
  driver_id uuid not null references drivers (id) on delete cascade,
  primary key (report_id, driver_id)
);

create index if not exists incident_report_drivers_driver_idx on incident_report_drivers (driver_id);

alter table incident_reports enable row level security;
alter table incident_report_drivers enable row level security;

drop policy if exists "reporter or admin read incident_reports" on incident_reports;
create policy "reporter or admin read incident_reports" on incident_reports
  for select using (is_admin() or reporter_id = (select auth.uid()));

drop policy if exists "reporter insert incident_reports" on incident_reports;
create policy "reporter insert incident_reports" on incident_reports
  for insert with check (reporter_id = (select auth.uid()) and status = 'open');

drop policy if exists "admin update incident_reports" on incident_reports;
create policy "admin update incident_reports" on incident_reports
  for update using (is_admin());

drop policy if exists "admin delete incident_reports" on incident_reports;
create policy "admin delete incident_reports" on incident_reports
  for delete using (is_admin());

drop policy if exists "reporter or admin read incident_report_drivers" on incident_report_drivers;
create policy "reporter or admin read incident_report_drivers" on incident_report_drivers
  for select using (
    is_admin() or exists (
      select 1 from incident_reports r
      where r.id = report_id and r.reporter_id = (select auth.uid())
    )
  );

drop policy if exists "reporter insert incident_report_drivers" on incident_report_drivers;
create policy "reporter insert incident_report_drivers" on incident_report_drivers
  for insert with check (
    exists (
      select 1 from incident_reports r
      where r.id = report_id and r.reporter_id = (select auth.uid())
    )
  );

drop policy if exists "admin delete incident_report_drivers" on incident_report_drivers;
create policy "admin delete incident_report_drivers" on incident_report_drivers
  for delete using (is_admin());
