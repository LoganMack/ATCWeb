-- Undo 0113_bound_incident_submissions.sql
-- Puts back the 0093/0097 behaviour: no window, posted-state or rate checks
-- in the submit RPCs, appeals open to signed-out visitors, uploads to
-- "<appeal id>/<n>-<file>" by anyone, 10 MB per file. Revert the app change
-- that uploads to "<user id>/<appeal id>/..." in the same go, or appeals with
-- attachments will be refused by the restored upload policy.

-- 4. Per-file limit back to 10 MB
update storage.buckets set file_size_limit = 10485760 where id = 'incident-appeals';

-- 3. Upload policy (as left by 0097)
drop policy if exists "signed-in upload own incident-appeals" on storage.objects;
drop policy if exists "anyone upload incident-appeals" on storage.objects;
create policy "anyone upload incident-appeals" on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'incident-appeals'
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9]+-[^/]+$'
  );
drop function if exists public.can_upload_incident_appeal_file();

-- 2. Appeal RPC (as in 0093)
create or replace function public.submit_incident_appeal(
  p_id uuid,
  p_penalty_id uuid,
  p_message text,
  p_files jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_subsession bigint;
begin
  if p_id is null then raise exception 'invalid id'; end if;
  if coalesce(btrim(p_message), '') = '' or length(p_message) > 4000 then raise exception 'invalid message'; end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) > 3 then
    raise exception 'invalid files';
  end if;

  select subsession_id into v_subsession from penalties where id = p_penalty_id;
  if v_subsession is null then raise exception 'unknown incident'; end if;

  if v_uid is not null then
    -- A login linked to a roster driver (Admin > Users > Driver) is named after that driver.
    select coalesce(d.name, p.display_name, u.email) into v_name
    from auth.users u left join profiles p on p.id = u.id left join drivers d on d.id = p.driver_id
    where u.id = v_uid;
  end if;

  insert into incident_appeals (id, subsession_id, penalty_id, message, files, submitter_id, submitter_name)
  values (p_id, v_subsession, p_penalty_id, btrim(p_message), p_files, v_uid, v_name);

  return p_id;
end;
$$;

revoke all on function public.submit_incident_appeal(uuid, uuid, text, jsonb) from public;
grant execute on function public.submit_incident_appeal(uuid, uuid, text, jsonb) to anon, authenticated;

-- 1. Report RPC (as in 0097)
create or replace function public.submit_incident_report(
  p_subsession_id bigint, p_session text, p_lap integer, p_turn text,
  p_description text, p_driver_ids uuid[]
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
  if p_lap is null or p_lap < 0 or p_lap > 1000 then raise exception 'invalid lap'; end if;
  if coalesce(btrim(p_turn), '') = '' or length(p_turn) > 80 then raise exception 'invalid turn'; end if;
  if p_description is not null and length(p_description) > 2000 then raise exception 'description too long'; end if;
  if p_driver_ids is null or cardinality(p_driver_ids) = 0 or cardinality(p_driver_ids) > 100 then
    raise exception 'at least one car is required';
  end if;
  if not exists (select 1 from curated_rounds where subsession_id = p_subsession_id) then
    raise exception 'unknown round';
  end if;

  if v_uid is not null then
    select coalesce(d.name, p.display_name, u.email) into v_name
    from auth.users u left join profiles p on p.id = u.id left join drivers d on d.id = p.driver_id
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
