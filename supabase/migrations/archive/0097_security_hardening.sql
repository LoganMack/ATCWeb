-- 0097_security_hardening.sql
-- Findings from the pre-sign-up-growth security audit. Every change here is
-- additive/tightening and keeps the app's existing flows working:
--
--  1. Signed-in non-admins could edit their OWN profile row freely (the
--     "update profile" RLS policy allows id = auth.uid()); the existing
--     trigger only protected `role`. They could therefore link themselves to
--     any roster driver (driver_id) or claim an iRacing id. Those three
--     columns are now admin-only, same as role.
--  2. "admin insert profiles" let a user insert their own profile row with
--     any role. Now they can only insert a plain 'driver' row.
--  3. Length cap on display_name (signup is open to the public).
--  4. page_views accepts anonymous inserts; constrain what they can write.
--  5. Uploads to the private incident-appeals bucket were allowed at ANY path
--     for anon/authenticated; limit to the "<appeal uuid>/<n>-<file>" shape
--     the app uses.
--  6. admin_* RPCs were EXECUTE-able by anon (they refuse non-admins inside,
--     but there is no reason to expose them at all).
--  7. Pin search_path on the three read-only stats functions.
--  8. Sanity cap on incident report lap numbers.

-- 1. Admin-only profile columns --------------------------------------------
create or replace function public.prevent_role_self_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    if new.role is distinct from old.role then
      raise exception 'Only an admin can change a profile role'
        using errcode = 'insufficient_privilege';
    end if;
    if new.driver_id is distinct from old.driver_id
       or new.iracing_cust_id is distinct from old.iracing_cust_id
       or new.iracing_name is distinct from old.iracing_name then
      raise exception 'Only an admin can link a profile to a driver or iRacing account'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

-- 2. Profile inserts: own row, plain driver only ----------------------------
drop policy if exists "admin insert profiles" on public.profiles;
create policy "admin insert profiles" on public.profiles
  for insert
  with check (
    public.is_admin()
    or (
      (select auth.uid()) = id
      and role = 'driver'
      and driver_id is null
      and iracing_cust_id is null
      and iracing_name is null
    )
  );

-- 3. display_name length (NOT VALID: don't fail on any pre-existing rows) ---
alter table public.profiles
  drop constraint if exists profiles_display_name_len;
alter table public.profiles
  add constraint profiles_display_name_len
  check (display_name is null or char_length(display_name) <= 80) not valid;

-- 4. page_views anonymous insert constraints -------------------------------
drop policy if exists "public insert page_views" on public.page_views;
create policy "public insert page_views" on public.page_views
  for insert
  with check (
    char_length(path) between 1 and 300
    and char_length(visitor_hash) between 1 and 64
    and (country is null or char_length(country) <= 8)
    and status between 100 and 599
  );

-- 5. incident-appeals uploads: only the app's own path shape ----------------
drop policy if exists "anyone upload incident-appeals" on storage.objects;
create policy "anyone upload incident-appeals" on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'incident-appeals'
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9]+-[^/]+$'
  );

-- 6. Don't expose admin RPCs to anonymous callers ---------------------------
revoke execute on function public.admin_delete_user(uuid) from anon, public;
revoke execute on function public.admin_list_user_emails() from anon, public;
grant execute on function public.admin_delete_user(uuid) to authenticated;
grant execute on function public.admin_list_user_emails() to authenticated;

-- 7. Pin search_path --------------------------------------------------------
alter function public.get_missing_race_results_count() set search_path = public;
alter function public.get_news_post_view_counts() set search_path = public;
alter function public.get_page_view_stats() set search_path = public;

-- 8. Incident report sanity cap ---------------------------------------------
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
