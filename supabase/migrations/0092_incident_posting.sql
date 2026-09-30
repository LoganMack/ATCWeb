-- Alpha Touring Challenge — per-round "Posted" flag for incident reports
--
-- A round's Incident Report page (src/pages/results/[subsessionId]/
-- incidents.astro) is only publicly viewable once stewards have finished
-- reviewing it and flipped that round to "Posted" (admin > Incident
-- Reporting). Until then the results page's Incident Report button reads
-- "Report Incident" during the reporting period and is disabled afterwards.
--
-- No row = not posted. Every round BEFORE ATC18 Round 3 (Charlotte,
-- subsession 88984251 — the first round run with driver-submitted incident
-- reports) is backfilled as posted so all earlier incident pages stay public.
--
-- Also seeds the editable reporting-period length (site_settings key
-- 'incident_report_period_hours', edited under admin > Site Properties).

create table if not exists round_incident_status (
  subsession_id bigint primary key,
  posted boolean not null default false,
  updated_at timestamptz not null default now()
);

drop trigger if exists round_incident_status_set_updated_at on round_incident_status;
create trigger round_incident_status_set_updated_at before update on round_incident_status
  for each row execute function set_updated_at();

alter table round_incident_status enable row level security;

drop policy if exists "public read round_incident_status" on round_incident_status;
create policy "public read round_incident_status" on round_incident_status for select using (true);
drop policy if exists "admin insert round_incident_status" on round_incident_status;
create policy "admin insert round_incident_status" on round_incident_status for insert with check (is_admin());
drop policy if exists "admin update round_incident_status" on round_incident_status;
create policy "admin update round_incident_status" on round_incident_status for update using (is_admin());
drop policy if exists "admin delete round_incident_status" on round_incident_status;
create policy "admin delete round_incident_status" on round_incident_status for delete using (is_admin());

insert into round_incident_status (subsession_id, posted)
select r.subsession_id, true
from curated_rounds r
where r.start_time < (select start_time from curated_rounds where subsession_id = 88984251)
on conflict (subsession_id) do nothing;

insert into site_settings (setting_key, value)
values ('incident_report_period_hours', '24')
on conflict (setting_key) do nothing;
