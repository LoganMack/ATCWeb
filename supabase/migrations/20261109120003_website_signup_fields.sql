-- New Driver Sign-Up fields (broadcaster-staff-roles; rules BR5.1-BR5.6).
--
-- What:
--   - signup_requests gains irating (0-20000) and nationality_1 / nationality_2 (two-letter country codes;
--     the second only with the first, and different from it). All three are optional in storage, so the
--     Discord bot's rows and rows from older site code stay valid.
--   - private.check_driver_request() holds the checks both website sign-up functions share: signed in,
--     not linked and not the Broadcaster, no pending request, at most three a day, the name, number and
--     iRacing id, and the number and iRacing id not already a driver's.
--   - submit_driver_signup() is the new page's call: it requires iRating, takes the nationalities and also
--     refuses a number another pending request asked for (CAR_NUMBER_REQUESTED).
--   - submit_driver_request() keeps its three-field signature and behaviour for the code on main, now
--     through the shared check. It is removed in a later contract step once no code calls it.
--   - taken_car_numbers() lists the numbers that are taken (a non-Inactive driver's, or asked for by a
--     pending request) for the live hint, to signed-in callers only, with no names or ids.
--   - approve_signup_request() copies iRating and nationalities to the driver: set on a new driver, and
--     filled only where a returning driver's own value is empty.
--
-- Why in the database: the hint on the page is only a hint; the number, field and limit rules must hold
-- whatever is posted, and approval writes the driver in the same transaction as the request.
--
-- Expand only (BR5.5): new columns and functions, and the old submit call unchanged, so the code on main
-- keeps working. Undo with supabase/down/20261109120003_website_signup_fields.down.sql.

-- 1. The request columns (BR5.1) -------------------------------------------------------------------------
alter table public.signup_requests
  add column irating integer,
  add column nationality_1 text,
  add column nationality_2 text;

alter table public.signup_requests
  add constraint signup_requests_irating_range check (irating is null or (irating >= 0 and irating <= 20000)),
  add constraint signup_requests_nationality_check check (
    (nationality_1 is null or nationality_1 ~ '^[a-z]{2}$')
    and (nationality_2 is null
         or (nationality_1 is not null and nationality_2 ~ '^[a-z]{2}$' and nationality_2 <> nationality_1)));

-- 2. The shared checks (BR5.1, BR5.2, BR5.4). Called only from the two definer functions below, so it runs
--    with their rights and needs no grant. Returns the trimmed name.
create function private.check_driver_request(p_uid uuid, p_name text, p_car_number integer, p_iracing_cust_id bigint)
  returns text
  language plpgsql
  set search_path to 'public'
  as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
begin
  if p_uid is null then
    raise exception 'NOT_AUTHENTICATED: Sign in to request a driver entry' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.profiles where id = p_uid and (driver_id is not null or is_broadcaster)) then
    raise exception 'ALREADY_LINKED: This account is already linked to a driver' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.signup_requests
    where requester_profile_id = p_uid and source = 'website' and status = 'pending'
  ) then
    raise exception 'REQUEST_PENDING: You already have a request waiting for an admin' using errcode = 'P0001';
  end if;
  -- Abuse limit: three requests a day per account.
  if (
    select count(*) from public.signup_requests
    where requester_profile_id = p_uid and source = 'website' and created_at > now() - interval '24 hours'
  ) >= 3 then
    raise exception 'REQUEST_LIMIT: You can send up to three requests a day' using errcode = 'P0001';
  end if;
  if length(v_name) < 1 or length(v_name) > 80 or v_name ~ '[[:cntrl:]]' then
    raise exception 'INVALID: name: Enter your full name (up to 80 characters)' using errcode = 'P0001';
  end if;
  if p_car_number is null or p_car_number < 0 or p_car_number > 999 then
    raise exception 'INVALID: car_number: Enter a car number from 0 to 999' using errcode = 'P0001';
  end if;
  if p_iracing_cust_id is null or p_iracing_cust_id <= 0 or p_iracing_cust_id > 9999999999999999 then
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
  return v_name;
end;
$$;

revoke all on function private.check_driver_request(uuid, text, integer, bigint) from public, anon, authenticated;

-- 3. The old three-field call, unchanged for main's code (BR5.5).
create or replace function public.submit_driver_request(p_name text, p_car_number integer, p_iracing_cust_id bigint)
  returns uuid
  language plpgsql security definer
  set search_path to 'public'
  as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_id uuid;
  v_constraint text;
begin
  v_name := private.check_driver_request(v_uid, p_name, p_car_number, p_iracing_cust_id);

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

-- 4. The New Driver Sign-Up call (BR5.1, BR5.2, BR5.4).
create function public.submit_driver_signup(p_name text, p_car_number integer, p_irating integer,
  p_iracing_cust_id bigint, p_nationality_1 text default null, p_nationality_2 text default null)
  returns uuid
  language plpgsql security definer
  set search_path to 'public'
  as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_nationality_1 text := nullif(lower(btrim(coalesce(p_nationality_1, ''))), '');
  v_nationality_2 text := nullif(lower(btrim(coalesce(p_nationality_2, ''))), '');
  v_id uuid;
  v_constraint text;
begin
  v_name := private.check_driver_request(v_uid, p_name, p_car_number, p_iracing_cust_id);
  if p_irating is null or p_irating < 0 or p_irating > 20000 then
    raise exception 'INVALID: irating: Enter your iRating (0 to 20000)' using errcode = 'P0001';
  end if;
  if v_nationality_1 is not null and v_nationality_1 !~ '^[a-z]{2}$' then
    raise exception 'INVALID: nationality_1: Pick a country from the list' using errcode = 'P0001';
  end if;
  if v_nationality_2 is not null and (v_nationality_1 is null or v_nationality_2 !~ '^[a-z]{2}$') then
    raise exception 'INVALID: nationality_2: Pick Nationality 1 first' using errcode = 'P0001';
  end if;
  if v_nationality_2 = v_nationality_1 then
    raise exception 'INVALID: nationality_2: Pick a different country from Nationality 1' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.signup_requests
    where status = 'pending' and p_car_number = any (requested_numbers)
  ) then
    raise exception 'CAR_NUMBER_REQUESTED: Car number % has already been asked for by another driver', p_car_number
      using errcode = 'P0001';
  end if;

  begin
    insert into public.signup_requests (source, requester_profile_id, name, iracing_cust_id, requested_numbers,
      irating, nationality_1, nationality_2)
    values ('website', v_uid, v_name, p_iracing_cust_id, array[p_car_number],
      p_irating, v_nationality_1, v_nationality_2)
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

-- 5. The taken numbers for the live hint (BR5.3): numbers only, signed-in callers only.
create function public.taken_car_numbers() returns integer[]
  language plpgsql stable security definer
  set search_path to 'public'
  as $$
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED: Sign in to link your driver' using errcode = 'P0001';
  end if;
  return (
    select coalesce(array_agg(n order by n), '{}')
    from (
      select d.car_number as n
      from public.drivers d
      join public.driver_statuses ds on ds.id = d.status_id
      where d.car_number is not null and ds.name <> 'Inactive'
      union
      select unnest(r.requested_numbers)
      from public.signup_requests r
      where r.status = 'pending'
    ) taken
  );
end;
$$;

revoke all on function public.submit_driver_signup(text, integer, integer, bigint, text, text) from public, anon;
revoke all on function public.taken_car_numbers() from public, anon;
grant execute on function public.submit_driver_signup(text, integer, integer, bigint, text, text) to authenticated;
grant execute on function public.taken_car_numbers() to authenticated;

-- 6. Approval copies iRating and nationalities (BR5.6); otherwise as in
--    20261109120000_staff_role_and_broadcaster.sql.
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
    insert into public.drivers (name, class_id, status_id, is_rookie, iracing_cust_id, sign_up_date, last_signed_up_at,
      starting_irating, nationality_1, nationality_2)
    values (v_name, p_class_id, v_status_id, true, v_iracing_cust_id, current_date, now(),
      v_request.irating, v_request.nationality_1, v_request.nationality_2)
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

    -- A returning driver's own iRating and nationalities win; the request only fills empty ones, and a
    -- second nationality is never set to the first.
    update public.drivers
    set status_id = v_status_id,
        class_id = p_class_id,
        iracing_cust_id = coalesce(iracing_cust_id, v_iracing_cust_id),
        last_signed_up_at = now(),
        starting_irating = coalesce(starting_irating, v_request.irating),
        nationality_1 = coalesce(nationality_1, v_request.nationality_1),
        nationality_2 = coalesce(nationality_2,
          case when coalesce(nationality_1, v_request.nationality_1) is not null
                and v_request.nationality_2 is distinct from coalesce(nationality_1, v_request.nationality_1)
               then v_request.nationality_2 end)
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
