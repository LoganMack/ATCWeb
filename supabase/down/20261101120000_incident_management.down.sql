-- Undoes 20261101120000_incident_management.sql: drops the own-appeal read policy, the three public
-- functions, the private window helper and caller predicates, and driver_incident_comments, then restores
-- submit_incident_appeal with its baseline body (copied verbatim from 20261020120000_baseline_schema.sql),
-- so any signed-in account may again appeal any penalty up to three times.
--
-- Every driver comment is lost. Appeals are kept: the migration never changed or deleted one. Revert the
-- site code first, so nothing calls the dropped functions.

drop policy "submitter read own" on public.incident_appeals;

-- The function is replaced before the helper it calls is dropped.
CREATE OR REPLACE FUNCTION "public"."submit_incident_appeal"("p_id" "uuid", "p_penalty_id" "uuid", "p_message" "text", "p_files" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_subsession bigint;
  v_posted_at timestamptz;
  v_period_hours integer;
  v_file jsonb;
begin
  if v_uid is null then raise exception 'sign in to submit an appeal'; end if;
  if p_id is null then raise exception 'invalid id'; end if;
  if coalesce(btrim(p_message), '') = '' or length(p_message) > 4000 then raise exception 'invalid message'; end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) > 3 then
    raise exception 'invalid files';
  end if;

  select subsession_id into v_subsession from penalties where id = p_penalty_id;
  if v_subsession is null then raise exception 'unknown incident'; end if;

  -- Appeal window: from posting until the appeal period runs out.
  select posted_at into v_posted_at
  from round_incident_status where subsession_id = v_subsession and posted;
  select case when value ~ '^[0-9]{1,4}$' then value::integer end into v_period_hours
  from site_settings where setting_key = 'incident_appeal_period_hours';
  if v_posted_at is null or now() > v_posted_at + make_interval(hours => coalesce(v_period_hours, 24)) then
    raise exception 'the appeal window for this round is closed';
  end if;

  -- Files must be the caller's own uploads for this appeal.
  for v_file in select * from jsonb_array_elements(p_files) loop
    if jsonb_typeof(v_file) <> 'object'
       or coalesce(v_file ->> 'path', '') !~ ('^' || v_uid::text || '/' || p_id::text || '/[0-9]+-[^/]+$')
       or not exists (
         select 1 from storage.objects o
         where o.bucket_id = 'incident-appeals' and o.name = v_file ->> 'path'
       ) then
      raise exception 'invalid files';
    end if;
  end loop;

  -- Per-submitter limits.
  perform pg_advisory_xact_lock(hashtextextended('incident_appeal:' || v_uid::text, 0));
  if (select count(*) from incident_appeals where penalty_id = p_penalty_id and submitter_id = v_uid) >= 3 then
    raise exception 'too many appeals for this incident';
  end if;
  if (select count(*) from incident_appeals where subsession_id = v_subsession and submitter_id = v_uid) >= 10 then
    raise exception 'too many appeals for this round';
  end if;

  -- A login linked to a roster driver (Admin > Users > Driver) is named after that driver.
  select coalesce(d.name, p.display_name, u.email) into v_name
  from auth.users u left join profiles p on p.id = u.id left join drivers d on d.id = p.driver_id
  where u.id = v_uid;

  insert into incident_appeals (id, subsession_id, penalty_id, message, files, submitter_id, submitter_name)
  values (p_id, v_subsession, p_penalty_id, btrim(p_message), p_files, v_uid, v_name);

  return p_id;
end;
$_$;

drop function public.can_appeal_penalty(uuid);
drop function public.add_my_incident_comment(uuid, text);
drop function public.my_incidents();

drop function private.is_penalty_party(uuid, uuid);
drop function private.caller_driver_id();
drop function private.appeal_window_closes_at(bigint);

drop table public.driver_incident_comments;
