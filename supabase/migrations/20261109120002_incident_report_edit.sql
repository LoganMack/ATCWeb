-- Edit Submission on reported incidents (broadcaster-staff-roles; rules BR4.1-BR4.5).
--
-- What: edit_incident_report_submission() lets an Admin or Staff member correct the four fields a reporter
-- entered on an open report: the session (Race), lap, turns and cars involved. The description, reporter
-- and timestamps never change. The new values pass the same checks as a new report, but the reporting
-- window and per-reporter limits don't apply, since this is a steward correction. A save that changes
-- nothing writes nothing; otherwise the report, its cars and one activity-log row ('edit',
-- 'incident_report', each field as "before -> after") are written in one transaction.
--
-- Why in the database: who may edit, and only while the report is open, must hold under concurrent
-- stewards, so the row is locked and the status checked in the same transaction as the write; the log
-- row in that transaction means no edit goes unrecorded.
--
-- Errors the site maps to messages are raised as '<CODE>: <message>' with errcode P0001:
-- REPORT_NOT_FOUND, REPORT_NOT_OPEN and 'INVALID: <field>: <message>' (session, lap, turn, driver_ids).
--
-- Expand only: a new function that nothing on main calls. Undo with
-- supabase/down/20261109120002_incident_report_edit.down.sql.

create function public.edit_incident_report_submission(p_report_id uuid, p_session text, p_lap integer,
  p_turn text, p_driver_ids uuid[]) returns jsonb
  language plpgsql security definer
  set search_path to 'public'
  as $$
declare
  v_uid uuid := auth.uid();
  v_report public.incident_reports%rowtype;
  v_turn text := btrim(coalesce(p_turn, ''));
  v_new_ids uuid[];
  v_old_ids uuid[];
  v_changes text[] := '{}';
  v_position bigint;
  v_track text;
  v_actor_name text;
begin
  if not public.is_admin() then
    raise exception 'Only an admin or staff member can edit a submission' using errcode = 'insufficient_privilege';
  end if;

  select * into v_report from public.incident_reports where id = p_report_id for update;
  if not found then
    raise exception 'REPORT_NOT_FOUND: That incident report no longer exists' using errcode = 'P0001';
  end if;
  if v_report.status <> 'open' then
    raise exception 'REPORT_NOT_OPEN: This report is no longer open, so it can''t be edited' using errcode = 'P0001';
  end if;

  -- The submission checks of submit_incident_report.
  if p_session is null or p_session !~ '^(race:[0-9]+|qualifying:0|practice:0)$' then
    raise exception 'INVALID: session: Pick the race the incident happened in' using errcode = 'P0001';
  end if;
  if p_lap is null or p_lap < 0 or p_lap > 1000 then
    raise exception 'INVALID: lap: Enter a lap from 0 to 1000' using errcode = 'P0001';
  end if;
  if v_turn = '' or length(v_turn) > 80 then
    raise exception 'INVALID: turn: Enter the turns (up to 80 characters)' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(distinct x order by x), '{}') into v_new_ids from unnest(p_driver_ids) as x;
  if cardinality(v_new_ids) < 1 or cardinality(v_new_ids) > 100
     or (select count(*) from public.drivers where id = any (v_new_ids)) <> cardinality(v_new_ids) then
    raise exception 'INVALID: driver_ids: Pick between 1 and 100 cars' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(driver_id order by driver_id), '{}') into v_old_ids
  from public.incident_report_drivers where report_id = p_report_id;

  -- A car a steward has already blamed stays on the report, so no review ends up naming a car that isn't in it.
  if exists (
    select 1
    from public.incident_report_review_drivers rd
    join public.incident_report_reviews r on r.id = rd.review_id
    where r.report_id = p_report_id and rd.driver_id <> all (v_new_ids)
  ) then
    raise exception 'INVALID: driver_ids: A steward review names a car you removed; keep it on the report'
      using errcode = 'P0001';
  end if;

  if p_session is distinct from v_report.session then
    v_changes := v_changes || format('Race: %s -> %s', v_report.session, p_session);
  end if;
  if p_lap is distinct from v_report.lap then
    v_changes := v_changes || format('Lap: %s -> %s', v_report.lap, p_lap);
  end if;
  if v_turn is distinct from v_report.turn then
    v_changes := v_changes || format('Turns: %s -> %s', v_report.turn, v_turn);
  end if;
  if v_new_ids is distinct from v_old_ids then
    v_changes := v_changes || format('Cars: %s -> %s',
      (select coalesce(string_agg(d.name, ', ' order by d.name), 'none') from public.drivers d where d.id = any (v_old_ids)),
      (select string_agg(d.name, ', ' order by d.name) from public.drivers d where d.id = any (v_new_ids)));
  end if;

  -- Nothing changed (including a double submit of the same edit): no write and no log row.
  if cardinality(v_changes) = 0 then
    return jsonb_build_object('changed', false);
  end if;

  update public.incident_reports
  set session = p_session,
      lap = p_lap,
      turn = v_turn
  where id = p_report_id;

  delete from public.incident_report_drivers where report_id = p_report_id and driver_id <> all (v_new_ids);
  insert into public.incident_report_drivers (report_id, driver_id)
  select p_report_id, x from unnest(v_new_ids) as x
  where x <> all (v_old_ids);

  -- "Edited incident report <n> - <track>", n being the report's position in its round.
  select r.n into v_position
  from (
    select id, row_number() over (order by created_at, id) as n
    from public.incident_reports
    where subsession_id = v_report.subsession_id
  ) r
  where r.id = p_report_id;
  select track_name into v_track from public.curated_rounds where subsession_id = v_report.subsession_id;
  select coalesce(d.name, p.display_name, u.email) into v_actor_name
  from auth.users u left join public.profiles p on p.id = u.id left join public.drivers d on d.id = p.driver_id
  where u.id = v_uid;

  insert into public.activity_log (actor_id, actor_name, action, entity_type, entity_label, entity_id, details)
  values (v_uid, coalesce(v_actor_name, 'Unknown'), 'edit', 'incident_report',
          format('Edited incident report %s - %s', v_position, coalesce(v_track, 'unknown track')),
          p_report_id::text, array_to_string(v_changes, E'\n'));

  return jsonb_build_object('changed', true);
end;
$$;

revoke all on function public.edit_incident_report_submission(uuid, text, integer, text, uuid[]) from public, anon;
grant execute on function public.edit_incident_report_submission(uuid, text, integer, text, uuid[]) to authenticated;
