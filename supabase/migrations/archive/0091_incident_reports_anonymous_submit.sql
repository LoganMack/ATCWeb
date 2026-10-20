-- Alpha Touring Challenge — let signed-out visitors report incidents
--
-- 0090 required a signed-in reporter. Reporting is now open to everyone, so
-- submission goes through a SECURITY DEFINER function instead of direct
-- table inserts (an anonymous caller has no SELECT policy to read its own
-- inserted row back, and this keeps report + involved cars atomic). The
-- function validates its inputs, derives the reporter from auth.uid() (NULL
-- for signed-out visitors — never trusted from the client), and snapshots
-- the reporter's name. Reads/updates/deletes stay admin-only (plus a
-- signed-in reporter's own rows) via 0090's policies.
--
-- The reporting WINDOW is still enforced in the app
-- (src/lib/incidentReports.ts), not here.

alter table incident_reports alter column reporter_id drop not null;
drop policy if exists "reporter insert incident_reports" on incident_reports;
drop policy if exists "reporter insert incident_report_drivers" on incident_report_drivers;

create or replace function public.submit_incident_report(
  p_subsession_id bigint,
  p_session text,
  p_lap integer,
  p_turn text,
  p_description text,
  p_driver_ids uuid[]
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_uid uuid := auth.uid();
  v_name text;
begin
  if p_session is null or p_session !~ '^(race:[0-9]+|qualifying:0|practice:0)$' then
    raise exception 'invalid session';
  end if;
  if p_lap is null or p_lap < 0 then raise exception 'invalid lap'; end if;
  if coalesce(btrim(p_turn), '') = '' or length(p_turn) > 80 then raise exception 'invalid turn'; end if;
  if p_description is not null and length(p_description) > 2000 then raise exception 'description too long'; end if;
  if p_driver_ids is null or cardinality(p_driver_ids) = 0 or cardinality(p_driver_ids) > 100 then
    raise exception 'at least one car is required';
  end if;
  if not exists (select 1 from curated_rounds where subsession_id = p_subsession_id) then
    raise exception 'unknown round';
  end if;

  if v_uid is not null then
    select coalesce(p.display_name, u.email) into v_name
    from auth.users u left join profiles p on p.id = u.id
    where u.id = v_uid;
  end if;

  insert into incident_reports (subsession_id, session, lap, turn, description, reporter_id, reporter_name)
  values (p_subsession_id, p_session, p_lap, btrim(p_turn), nullif(btrim(coalesce(p_description, '')), ''), v_uid, v_name)
  returning id into v_id;

  insert into incident_report_drivers (report_id, driver_id)
  select v_id, d.id from drivers d where d.id = any (p_driver_ids);
  if not found then raise exception 'no valid cars'; end if;

  return v_id;
end;
$$;

revoke all on function public.submit_incident_report(bigint, text, integer, text, text, uuid[]) from public;
grant execute on function public.submit_incident_report(bigint, text, integer, text, text, uuid[]) to anon, authenticated;
