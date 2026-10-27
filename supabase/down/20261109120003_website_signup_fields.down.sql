-- Undoes 20261109120003_website_signup_fields.sql: drops the new sign-up and taken-numbers functions and
-- the shared check, puts back submit_driver_request() and approve_signup_request() exactly as
-- 20261109120000_staff_role_and_broadcaster.sql defines them, and drops the three request columns.
--
-- It refuses while any request holds an iRating or a nationality, so none is silently lost. To roll back
-- after launch, first export them in the SQL editor (select * from public.signup_requests where irating is
-- not null or nationality_1 is not null, then download the result as CSV), clear them
-- (update public.signup_requests set irating = null, nationality_1 = null, nationality_2 = null), and then
-- run this script again. Drivers that approval already filled keep their values.

do $$
begin
  if exists (select 1 from public.signup_requests where irating is not null or nationality_1 is not null or nationality_2 is not null) then
    raise exception 'Sign-up requests hold an iRating or a nationality. Export them (select * from public.signup_requests where irating is not null or nationality_1 is not null), clear them (update public.signup_requests set irating = null, nationality_1 = null, nationality_2 = null), then run this script again.';
  end if;
end $$;

drop function public.submit_driver_signup(text, integer, integer, bigint, text, text);
drop function public.taken_car_numbers();

-- 20261109120000_staff_role_and_broadcaster.sql's versions, verbatim.
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
  if exists (select 1 from public.profiles where id = v_uid and (driver_id is not null or is_broadcaster)) then
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
  v_requester_is_broadcaster boolean;
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
    select driver_id, is_broadcaster into v_requester_driver_id, v_requester_is_broadcaster
    from public.profiles where id = v_request.requester_profile_id
    for update;
    if v_requester_driver_id is not null then
      raise exception 'REQUESTER_ALREADY_LINKED: The requester is already linked to a driver'
        using errcode = 'P0001';
    end if;
    if v_requester_is_broadcaster then
      raise exception 'REQUESTER_IS_BROADCASTER: This account is the Broadcaster, so it can''t be linked to a driver. Reject the request instead'
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
    perform set_config('atc.approval_link', 'on', true);
    begin
      -- The unique link catches a race with another account.
      update public.profiles set driver_id = v_driver_id where id = v_request.requester_profile_id;
    exception
      when unique_violation then
        perform set_config('atc.approval_link', 'off', true);
        raise exception 'DRIVER_ALREADY_LINKED: % is already linked to another account',
          (select name from public.drivers where id = v_driver_id) using errcode = 'P0001';
      when check_violation then
        perform set_config('atc.approval_link', 'off', true);
        raise exception 'REQUESTER_IS_BROADCASTER: This account is the Broadcaster, so it can''t be linked to a driver. Reject the request instead'
          using errcode = 'P0001';
    end;
    perform set_config('atc.approval_link', 'off', true);
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

drop function private.check_driver_request(uuid, text, integer, bigint);

alter table public.signup_requests
  drop constraint signup_requests_nationality_check,
  drop constraint signup_requests_irating_range;

alter table public.signup_requests
  drop column nationality_2,
  drop column nationality_1,
  drop column irating;
