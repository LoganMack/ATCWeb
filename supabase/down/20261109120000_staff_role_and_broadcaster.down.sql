-- Undoes 20261109120000_staff_role_and_broadcaster.sql: drops the Broadcaster functions, the marker and
-- the full-Admin helper, and puts back the admin helper, the profiles guard, the hand insert policy, the
-- hidden-driver set, admin_delete_user and the four linking functions exactly as they were before.
--
-- It refuses while any account is Staff or the Broadcaster, so no account silently changes role or loses
-- its marker. Remove the Broadcaster and change every Staff account to Driver (or Admin) in Admin > Users
-- first, then run this script again. Run the later migrations' down scripts before this one.

do $$
begin
  if exists (select 1 from public.profiles where role = 'staff' or is_broadcaster) then
    raise exception 'Staff accounts or the Broadcaster exist. Remove the Broadcaster and change every Staff account in Admin > Users, then run this script again.';
  end if;
end $$;

drop function public.claim_broadcaster();
drop function public.admin_set_broadcaster(uuid);
drop function public.broadcaster_slot_taken();

-- 20261027120000_driver_linking.sql's versions, verbatim.
create or replace function public.prevent_role_self_escalation() returns trigger
  language plpgsql security definer
  set search_path to 'public'
  as $$
begin
  if not public.is_admin() then
    if new.role is distinct from old.role then
      raise exception 'Only an admin can change a profile role'
        using errcode = 'insufficient_privilege';
    end if;
    if (new.driver_id is distinct from old.driver_id
        and not (old.driver_id is null
                 and new.driver_id is not null
                 and coalesce(current_setting('atc.self_link', true), '') = 'on'))
       or new.iracing_cust_id is distinct from old.iracing_cust_id
       or new.iracing_name is distinct from old.iracing_name then
      raise exception 'Only an admin can link a profile to a driver or iRacing account'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.link_my_driver(p_driver_id uuid) returns jsonb
  language plpgsql security definer
  set search_path to 'public'
  as $$
declare
  v_uid uuid := auth.uid();
  v_request_id uuid;
  v_driver_name text;
  v_is_ai boolean;
  v_actor_name text;
  v_rows integer;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED: Sign in to link your driver' using errcode = 'P0001';
  end if;

  -- Same lock order as approve_signup_request (request, then profile), so the two cannot deadlock.
  select id into v_request_id
  from public.signup_requests
  where requester_profile_id = v_uid and source = 'website' and status = 'pending'
  for update;

  if exists (select 1 from public.profiles where id = v_uid and driver_id is not null) then
    raise exception 'ALREADY_LINKED: This account is already linked to a driver' using errcode = 'P0001';
  end if;

  select name, is_ai into v_driver_name, v_is_ai from public.drivers where id = p_driver_id;
  if not found or v_is_ai then
    raise exception 'NOT_FOUND: That driver can''t be linked' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.profiles where driver_id = p_driver_id) then
    raise exception 'DRIVER_TAKEN: % was just linked to another account', v_driver_name using errcode = 'P0001';
  end if;

  perform set_config('atc.self_link', 'on', true);
  begin
    update public.profiles set driver_id = p_driver_id where id = v_uid and driver_id is null;
    get diagnostics v_rows = row_count;
  exception when unique_violation then
    -- Another account linked the same driver after the check above.
    perform set_config('atc.self_link', 'off', true);
    raise exception 'DRIVER_TAKEN: % was just linked to another account', v_driver_name using errcode = 'P0001';
  end;
  perform set_config('atc.self_link', 'off', true);

  if v_rows = 0 then
    raise exception 'ALREADY_LINKED: This account is already linked to a driver' using errcode = 'P0001';
  end if;

  if v_request_id is not null then
    update public.signup_requests
    set status = 'cancelled',
        decided_at = now()
    where id = v_request_id;
  end if;

  -- Written here because a driver cannot insert activity rows for a driver themselves.
  select coalesce(nullif(btrim(display_name), ''), v_driver_name) into v_actor_name
  from public.profiles where id = v_uid;
  insert into public.activity_log (actor_id, actor_name, action, entity_type, entity_label, entity_id)
  values (v_uid, v_actor_name, 'edit', 'driver',
          v_actor_name || ' linked their account to ' || v_driver_name, p_driver_id::text);

  return jsonb_build_object('driver_id', p_driver_id);
end;
$$;

create or replace function public.my_link_state() returns jsonb
  language plpgsql stable security definer
  set search_path to 'public'
  as $$
declare
  v_uid uuid := auth.uid();
  v_driver_id uuid;
  v_status text;
  v_name text;
  v_car_number integer;
  v_reason text;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED: Sign in to link your driver' using errcode = 'P0001';
  end if;
  select driver_id into v_driver_id from public.profiles where id = v_uid;
  select r.status, r.name, r.requested_numbers[1], r.reason
    into v_status, v_name, v_car_number, v_reason
  from public.signup_requests r
  where r.requester_profile_id = v_uid and r.source = 'website'
  order by r.created_at desc, r.id desc
  limit 1;
  return jsonb_build_object(
    'linked', v_driver_id is not null,
    'driver_id', v_driver_id,
    'request', case
      when v_status in ('pending', 'rejected') then jsonb_build_object(
        'status', v_status, 'name', v_name, 'car_number', v_car_number, 'reason', v_reason)
      else null
    end);
end;
$$;

create or replace function public.submit_driver_request(p_name text, p_car_number integer, p_iracing_cust_id bigint)
  returns uuid
  language plpgsql security definer
  set search_path to 'public'
  as $$
declare
  v_uid uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
  v_constraint text;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED: Sign in to request a driver entry' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.profiles where id = v_uid and driver_id is not null) then
    raise exception 'ALREADY_LINKED: This account is already linked to a driver' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.signup_requests
    where requester_profile_id = v_uid and source = 'website' and status = 'pending'
  ) then
    raise exception 'REQUEST_PENDING: You already have a request waiting for an admin' using errcode = 'P0001';
  end if;
  -- Abuse limit: three requests a day per account.
  if (
    select count(*) from public.signup_requests
    where requester_profile_id = v_uid and source = 'website' and created_at > now() - interval '24 hours'
  ) >= 3 then
    raise exception 'REQUEST_LIMIT: You can send up to three requests a day' using errcode = 'P0001';
  end if;
  if length(v_name) < 1 or length(v_name) > 80 or v_name ~ '[[:cntrl:]]' then
    raise exception 'INVALID: name: Enter your full name (up to 80 characters)' using errcode = 'P0001';
  end if;
  if p_car_number is null or p_car_number < 0 or p_car_number > 999 then
    raise exception 'INVALID: car_number: Enter a car number from 0 to 999' using errcode = 'P0001';
  end if;
  if p_iracing_cust_id is null or p_iracing_cust_id <= 0 then
    raise exception 'INVALID: iracing_cust_id: Enter your iRacing customer ID' using errcode = 'P0001';
  end if;
  if public.car_number_holder(p_car_number, null) is not null then
    raise exception 'CAR_NUMBER_TAKEN: Car number % already belongs to a driver', p_car_number
      using errcode = 'P0001';
  end if;
  if exists (select 1 from public.drivers where iracing_cust_id = p_iracing_cust_id) then
    raise exception 'IRACING_ID_TAKEN: That iRacing customer ID already belongs to a driver'
      using errcode = 'P0001';
  end if;

  begin
    insert into public.signup_requests (source, requester_profile_id, name, iracing_cust_id, requested_numbers)
    values ('website', v_uid, v_name, p_iracing_cust_id, array[p_car_number])
    returning id into v_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    -- A second request sent at the same moment as the first.
    if v_constraint = 'signup_requests_one_pending_per_requester' then
      raise exception 'REQUEST_PENDING: You already have a request waiting for an admin' using errcode = 'P0001';
    end if;
    raise;
  end;
  return v_id;
end;
$$;

create or replace function public.approve_signup_request(p_request_id uuid, p_name text, p_iracing_cust_id bigint,
  p_class_id integer, p_driver_id uuid default null::uuid) returns jsonb
  language plpgsql security definer
  set search_path to 'public'
  as $$
declare
  v_request public.signup_requests%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_driver_id uuid := p_driver_id;
  v_iracing_cust_id bigint := p_iracing_cust_id;
  v_current_number integer;
  v_number integer;
  v_n integer;
  v_has_raced boolean;
  v_status_id integer;
  v_current_status text;
  v_existing_cust_id bigint;
  v_driver_name text;
  v_requester_driver_id uuid;
begin
  if not is_admin() then
    raise exception 'Only an admin can approve sign-ups' using errcode = 'insufficient_privilege';
  end if;

  select * into v_request from public.signup_requests where id = p_request_id for update;
  if not found then
    raise exception 'Sign-up request not found';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'This sign-up has already been %', v_request.status;
  end if;
  if p_class_id is null or not exists (select 1 from public.driver_classes where id = p_class_id) then
    raise exception 'Pick a class';
  end if;

  if v_request.source = 'website' then
    v_iracing_cust_id := coalesce(p_iracing_cust_id, v_request.iracing_cust_id);
    -- Request, then profile: the same lock order as link_my_driver.
    select driver_id into v_requester_driver_id
    from public.profiles where id = v_request.requester_profile_id
    for update;
    if v_requester_driver_id is not null then
      raise exception 'REQUESTER_ALREADY_LINKED: The requester is already linked to a driver'
        using errcode = 'P0001';
    end if;
    if v_driver_id is not null and exists (select 1 from public.profiles where driver_id = v_driver_id) then
      raise exception 'DRIVER_ALREADY_LINKED: % is already linked to another account',
        (select name from public.drivers where id = v_driver_id) using errcode = 'P0001';
    end if;
  end if;

  -- Friendly versions of the drivers table's unique constraints.
  if v_iracing_cust_id is not null and exists (
    select 1 from public.drivers
    where iracing_cust_id = v_iracing_cust_id and (v_driver_id is null or id <> v_driver_id)
  ) then
    raise exception 'iRacing ID % already belongs to % — approve it as that returning driver instead',
      v_iracing_cust_id, (select name from public.drivers where iracing_cust_id = v_iracing_cust_id);
  end if;
  if v_driver_id is null and exists (select 1 from public.drivers where lower(name) = lower(v_name)) then
    raise exception 'A driver named % is already on the roster — approve it as that returning driver, or change the name',
      (select name from public.drivers where lower(name) = lower(v_name) limit 1);
  end if;

  if v_driver_id is not null then
    -- Returning driver: keep their number if they still hold one.
    select car_number into v_current_number from public.drivers where id = v_driver_id for update;
    if not found then
      raise exception 'The selected roster driver no longer exists';
    end if;
  end if;

  if v_current_number is not null then
    v_number := v_current_number;
  else
    foreach v_n in array v_request.requested_numbers loop
      if public.car_number_holder(v_n, v_driver_id) is null then
        v_number := v_n;
        exit;
      end if;
    end loop;
    if v_number is null then
      raise exception 'None of the requested numbers (%) is free any more — reject this sign-up instead',
        array_to_string(v_request.requested_numbers, ', ');
    end if;
  end if;

  if v_driver_id is null then
    if length(v_name) = 0 then
      raise exception 'A driver name is required';
    end if;
    select id into v_status_id from public.driver_statuses where name = 'New';
    insert into public.drivers (name, class_id, status_id, is_rookie, iracing_cust_id, sign_up_date, last_signed_up_at)
    values (v_name, p_class_id, v_status_id, true, v_iracing_cust_id, current_date, now())
    returning id into v_driver_id;
  else
    -- Never silently replace an iRacing ID: it's what links the driver to
    -- their results.
    select iracing_cust_id, name into v_existing_cust_id, v_driver_name from public.drivers where id = v_driver_id;
    if v_iracing_cust_id is not null and v_existing_cust_id is not null and v_iracing_cust_id <> v_existing_cust_id then
      raise exception '% already has iRacing ID %, but this sign-up says % — check which is right, and clear the iRacing ID field to keep theirs',
        v_driver_name, v_existing_cust_id, v_iracing_cust_id;
    end if;

    -- Veterans stay Veteran (they're exempt from inactivity). Anyone else goes
    -- back to Active if they've raced before, New if they never have — the
    -- same split sync_driver_statuses() uses.
    select ds.name into v_current_status
    from public.drivers d join public.driver_statuses ds on ds.id = d.status_id
    where d.id = v_driver_id;
    if v_current_status = 'Veteran' then
      select status_id into v_status_id from public.drivers where id = v_driver_id;
    else
      select lr.last_race_at is not null into v_has_raced
      from public.driver_last_race lr where lr.driver_id = v_driver_id;
      select id into v_status_id from public.driver_statuses
      where name = case when coalesce(v_has_raced, false) then 'Active' else 'New' end;
    end if;

    update public.drivers
    set status_id = v_status_id,
        class_id = p_class_id,
        iracing_cust_id = coalesce(iracing_cust_id, v_iracing_cust_id),
        last_signed_up_at = now()
    where id = v_driver_id;
  end if;

  if v_current_number is null then
    -- Logan's number rule, including freeing it from an Inactive holder.
    perform public.set_driver_car_number(v_driver_id, v_number);
  end if;

  if v_request.source = 'website' then
    begin
      -- The admin passes the profiles guard; the unique link catches a race with another account.
      update public.profiles set driver_id = v_driver_id where id = v_request.requester_profile_id;
    exception when unique_violation then
      raise exception 'DRIVER_ALREADY_LINKED: % is already linked to another account',
        (select name from public.drivers where id = v_driver_id) using errcode = 'P0001';
    end;
  end if;

  update public.signup_requests
  set status = 'approved',
      driver_id = v_driver_id,
      iracing_cust_id = case when source = 'website' then v_iracing_cust_id else iracing_cust_id end,
      decided_by = auth.uid(),
      decided_at = now()
  where id = p_request_id;

  -- The roster name, which for a returning driver can differ from the sign-up's.
  select name into v_driver_name from public.drivers where id = v_driver_id;
  return jsonb_build_object('driver_id', v_driver_id, 'driver_name', v_driver_name, 'car_number', v_number);
end;
$$;

-- The baseline's versions (supabase/migrations/20261020120000_baseline_schema.sql), verbatim.
CREATE OR REPLACE FUNCTION "public"."admin_delete_user"("p_user_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete users' using errcode = 'insufficient_privilege';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'You cannot delete your own account' using errcode = 'invalid_parameter_value';
  end if;
  update public.incident_reports set reporter_id = null where reporter_id = p_user_id;
  delete from auth.users where id = p_user_id;
  if not found then
    raise exception 'No such user' using errcode = 'no_data_found';
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION "private"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$;

drop policy "admin insert profiles" on public.profiles;
CREATE POLICY "admin insert profiles" ON "public"."profiles" FOR INSERT WITH CHECK (("public"."is_admin"() OR ((( SELECT "auth"."uid"() AS "uid") = "id") AND ("role" = 'driver'::"text") AND ("driver_id" IS NULL) AND ("iracing_cust_id" IS NULL) AND ("iracing_name" IS NULL))));
drop policy "update profile" on public.profiles;
CREATE POLICY "update profile" ON "public"."profiles" FOR UPDATE USING (("public"."is_admin"() OR (( SELECT "auth"."uid"() AS "uid") = "id")));

-- 20261029120000_driver_privacy_views.sql's hidden set and comment, verbatim.
create or replace view private.hidden_drivers as
select
  d.id as driver_id,
  p.id as profile_id,
  d.name as full_name,
  s.hide_name as name_hidden,
  (s.hide_name or s.hide_profile) as profile_private
from public.drivers d
join public.profiles p on p.driver_id = d.id
join public.account_settings s on s.profile_id = p.id
where (s.hide_name or s.hide_profile)
  and not exists (
    select 1
    from public.profiles v
    where v.id = (select auth.uid())
      and (v.role = 'admin' or v.driver_id is not null)
  );

comment on view private.hidden_drivers is
  'Drivers hidden from the current caller (U4): empty for admins and linked drivers. Read only by the *_shown views.';

drop function public.is_full_admin();
drop function private.is_full_admin();

drop index public.profiles_one_broadcaster;
alter table public.profiles drop constraint profiles_broadcaster_not_linked_check;
alter table public.profiles drop column is_broadcaster;

alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role = any (array['admin'::text, 'driver'::text]));
