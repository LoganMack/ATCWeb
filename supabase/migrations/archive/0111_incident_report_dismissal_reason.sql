-- Alpha Touring Challenge — a reason for every dismissed incident report
--
-- Dismissing a driver-submitted report on the Reported Incidents page now asks
-- the steward why; the reason is shown in the Dismissed list. Stored on the
-- report itself and cleared again whenever the report leaves 'dismissed'
-- (Reopen, or logging it), so a stale reason never outlives its dismissal.
--
-- Reports dismissed before this migration simply have no reason.

alter table incident_reports add column if not exists dismissal_reason text;

alter table incident_reports drop constraint if exists incident_reports_dismissal_reason_len;
alter table incident_reports add constraint incident_reports_dismissal_reason_len
  check (dismissal_reason is null or char_length(dismissal_reason) between 1 and 500);

create or replace function public.clear_incident_report_dismissal_reason()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from 'dismissed' then
    new.dismissal_reason := null;
  end if;
  return new;
end;
$$;

drop trigger if exists incident_reports_clear_dismissal_reason on incident_reports;
create trigger incident_reports_clear_dismissal_reason
  before insert or update on incident_reports
  for each row execute function public.clear_incident_report_dismissal_reason();
