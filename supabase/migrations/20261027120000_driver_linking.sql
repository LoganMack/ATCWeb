-- Driver linking (U2 driver-linking, US3.1-US3.4; contracts C1 and C2).
--
-- What: a signed-in account can link itself to one roster driver, once, and an account whose driver
-- is not on the roster can ask for a new driver entry from the website. Website requests share the
-- Admin > Sign-ups queue with the Discord bot's requests; approving one creates (or matches) the
-- driver and links it to the requester in the same transaction.
--
-- Why in the database: the rules (one account per driver, a link only from "no driver", only
-- through link_my_driver, admins approve) must hold whatever the page does, so they live in a unique
-- index, the profiles trigger and SECURITY DEFINER functions.
--
-- Expand only: existing rows become source 'discord', the Discord bot's functions and fields keep
-- working, and its rejection feed never sees website rows. Undo with
-- supabase/down/20261027120000_driver_linking.down.sql.
--
-- Errors the site maps to messages are raised as '<CODE>: <message>' with errcode P0001
-- (src/lib/driverAccount.ts reads the prefix).

-- 1. Pre-check: the unique link below cannot be created over duplicates.
do $$
declare
  v_duplicates text;
begin
  select string_agg(driver_id::text, ', ' order by driver_id) into v_duplicates
  from (
    select driver_id from public.profiles
    where driver_id is not null
    group by driver_id
    having count(*) > 1
  ) d;
  if v_duplicates is not null then
    raise exception 'Two or more accounts are linked to the same driver; fix them with a data fix first: %',
      v_duplicates;
  end if;
end $$;

-- 2. One account per driver (BR3.7). A concurrent second link fails with a unique violation.
create unique index profiles_driver_id_unique on public.profiles using btree (driver_id)
  where driver_id is not null;

-- 3. The profiles guard, with one opening for self-linking (BR3.8). Every other branch is unchanged.
--    atc.self_link must only ever be set transaction-local (set_config(..., true)) and only inside
--    link_my_driver, which resets it on every path out of its update (its EXCEPTION handler
--    included). Never set it anywhere else: while it is on, the caller can link a driver.
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

-- 4. Website requests in the sign-up queue (C2).
alter table public.signup_requests
  add column source text not null default 'discord',
  add column requester_profile_id uuid;

alter table public.signup_requests alter column discord_user_id drop not null;

alter table public.signup_requests
  add constraint signup_requests_source_check check (source in ('discord', 'website')),
  add constraint signup_requests_requester_profile_id_fkey
    foreign key (requester_profile_id) references public.profiles (id) on delete set null,
  add constraint signup_requests_discord_shape_check
    check (source <> 'discord' or discord_user_id is not null),
  -- A decided row may lose its requester when the account is deleted (NFR1.7), so the requester is
  -- required only while the request is pending.
  add constraint signup_requests_website_shape_check
    check (source <> 'website' or (
      iracing_cust_id is not null
      and cardinality(requested_numbers) = 1
      and (status <> 'pending' or requester_profile_id is not null)));

alter table public.signup_requests drop constraint signup_requests_status_check;
alter table public.signup_requests
  add constraint signup_requests_status_check
    check (status in ('pending', 'approved', 'rejected', 'cancelled')
           and (status <> 'cancelled' or source = 'website'));

create unique index signup_requests_one_pending_per_requester on public.signup_requests
  using btree (requester_profile_id) where status = 'pending' and source = 'website';

-- The foreign key's index, also used by the 24-hour request limit.
create index signup_requests_requester_profile_id_idx on public.signup_requests
  using btree (requester_profile_id, created_at);

-- 5. Deleting an account cancels its pending website request first, so the pending row never
--    loses its requester (the shape check) and admin_delete_user keeps working (NFR1.7).
create function public.cancel_requester_pending_request() returns trigger
  language plpgsql security definer
  set search_path to 'public'
  as $$
begin
  update public.signup_requests
  set status = 'cancelled',
      decided_at = now()
  where requester_profile_id = old.id and source = 'website' and status = 'pending';
  return old;
end;
$$;

revoke all on function public.cancel_requester_pending_request() from public, anon, authenticated;

create trigger profiles_cancel_requester_pending_request
  before delete on public.profiles
  for each row execute function public.cancel_requester_pending_request();

-- 6. Self-service functions (signed-in callers only; NFR1.4).

-- Links the caller to a driver, once (BR3.6, BR3.7, BR3.9).
create function public.link_my_driver(p_driver_id uuid) returns jsonb
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

-- Drivers an account can link to (BR3.3). Real names are right here: only drivers no account is
-- linked to are listed, and privacy lives on the account, so none of them can be hidden (C1).
create function public.list_unlinked_drivers() returns table (id uuid, name text, car_number integer)
  language plpgsql stable security definer
  set search_path to 'public'
  as $$
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED: Sign in to link your driver' using errcode = 'P0001';
  end if;
  return query
    select d.id, d.name, d.car_number
    from public.drivers d
    where not d.is_ai
      and not exists (select 1 from public.profiles p where p.driver_id = d.id)
    order by lower(d.name), d.id;
end;
$$;

-- The caller's link and their latest website request while it is pending, or rejected and not
-- superseded by a newer one (C1 LinkState). signup_requests has no requester read policy.
create function public.my_link_state() returns jsonb
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

-- Asks for a new driver entry (BR3.10). The checks run in the order the page expects. The number and
-- iRacing id are checked again when an admin approves, so a clash that appears in between is caught
-- there and the request stays pending.
create function public.submit_driver_request(p_name text, p_car_number integer, p_iracing_cust_id bigint)
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

revoke all on function public.link_my_driver(uuid) from public, anon;
revoke all on function public.list_unlinked_drivers() from public, anon;
revoke all on function public.my_link_state() from public, anon;
revoke all on function public.submit_driver_request(text, integer, bigint) from public, anon;
grant execute on function public.link_my_driver(uuid) to authenticated;
grant execute on function public.list_unlinked_drivers() to authenticated;
grant execute on function public.my_link_state() to authenticated;
grant execute on function public.submit_driver_request(text, integer, bigint) to authenticated;

-- 7. Admin approval: unchanged for Discord rows. For website rows the admin may correct the iRacing
--    id (as for Discord rows; an empty field keeps the requested one), and the approved driver is
--    linked to the requester in the same transaction, so any error leaves the request pending
--    (BR3.13, NFR1.5).
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

-- Rejection: a reason is required for every row as before; website requesters read it on the
-- linking page rather than in a Discord DM, so their message says so (BR3.14).
create or replace function public.reject_signup_request(p_request_id uuid, p_reason text) returns void
  language plpgsql security definer
  set search_path to 'public'
  as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_source text;
begin
  if not is_admin() then
    raise exception 'Only an admin can reject sign-ups' using errcode = 'insufficient_privilege';
  end if;
  select source into v_source from public.signup_requests where id = p_request_id;
  if length(v_reason) = 0 or length(v_reason) > 500 then
    if v_source = 'website' then
      raise exception 'A reason (up to 500 characters) is required — the requester reads it on the linking page';
    end if;
    raise exception 'A reason (up to 500 characters) is required — it is sent to the driver';
  end if;

  update public.signup_requests
  set status = 'rejected',
      reason = v_reason,
      decided_by = auth.uid(),
      decided_at = now()
  where id = p_request_id and status = 'pending';
  if not found then
    raise exception 'This sign-up is no longer pending';
  end if;
end;
$$;

-- The Discord bot's rejection feed and its acknowledgement see Discord rows only (BR3.15, NFR1.8).
create or replace function public.pending_signup_rejections()
  returns table (request_id uuid, discord_user_id text, name text, reason text)
  language sql stable security definer
  set search_path to 'public'
  as $$
  select id, discord_user_id, name, reason
  from public.signup_requests
  where status = 'rejected' and notified_at is null and source = 'discord'
  order by decided_at;
$$;

create or replace function public.ack_signup_rejections(p_request_ids uuid[]) returns integer
  language plpgsql security definer
  set search_path to 'public'
  as $$
declare
  v_count integer;
begin
  update public.signup_requests
  set notified_at = now()
  where id = any (p_request_ids) and status = 'rejected' and notified_at is null and source = 'discord';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
