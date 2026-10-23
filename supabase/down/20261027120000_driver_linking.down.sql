-- Undoes 20261027120000_driver_linking.sql: drops the self-service linking functions, the delete
-- trigger, the website request columns, constraints and indexes and the unique driver link, and puts
-- back the original profiles guard and sign-up functions exactly as the baseline defines them.
--
-- It refuses while website or cancelled sign-up requests exist, so it can never silently delete
-- them. To roll back after launch, first export them in the SQL editor
-- (select * from public.signup_requests where source = 'website' or status = 'cancelled', then
-- download the result as CSV), delete them
-- (delete from public.signup_requests where source = 'website' or status = 'cancelled'), and then
-- run this script. Links made through the linking page stay on the profiles; only the rule that
-- each driver has one account goes.

do $$
begin
  if exists (select 1 from public.signup_requests where source = 'website' or status = 'cancelled') then
    raise exception 'Website or cancelled sign-up requests exist. Export them (select * from public.signup_requests where source = ''website'' or status = ''cancelled''), delete them (delete from public.signup_requests where source = ''website'' or status = ''cancelled''), then run this script again.';
  end if;
end $$;

drop function public.link_my_driver(uuid);
drop function public.list_unlinked_drivers();
drop function public.my_link_state();
drop function public.submit_driver_request(text, integer, bigint);

drop trigger profiles_cancel_requester_pending_request on public.profiles;
drop function public.cancel_requester_pending_request();

-- The baseline's functions, verbatim (supabase/migrations/20261020120000_baseline_schema.sql).
CREATE OR REPLACE FUNCTION "public"."prevent_role_self_escalation"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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

CREATE OR REPLACE FUNCTION "public"."approve_signup_request"("p_request_id" "uuid", "p_name" "text", "p_iracing_cust_id" bigint, "p_class_id" integer, "p_driver_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_request public.signup_requests%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_driver_id uuid := p_driver_id;
  v_current_number integer;
  v_number integer;
  v_n integer;
  v_has_raced boolean;
  v_status_id integer;
  v_current_status text;
  v_existing_cust_id bigint;
  v_driver_name text;
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
  -- Friendly versions of the drivers table's unique constraints.
  if p_iracing_cust_id is not null and exists (
    select 1 from public.drivers
    where iracing_cust_id = p_iracing_cust_id and (v_driver_id is null or id <> v_driver_id)
  ) then
    raise exception 'iRacing ID % already belongs to % — approve it as that returning driver instead',
      p_iracing_cust_id, (select name from public.drivers where iracing_cust_id = p_iracing_cust_id);
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
    values (v_name, p_class_id, v_status_id, true, p_iracing_cust_id, current_date, now())
    returning id into v_driver_id;
  else
    -- Never silently replace an iRacing ID: it's what links the driver to
    -- their results.
    select iracing_cust_id, name into v_existing_cust_id, v_driver_name from public.drivers where id = v_driver_id;
    if p_iracing_cust_id is not null and v_existing_cust_id is not null and p_iracing_cust_id <> v_existing_cust_id then
      raise exception '% already has iRacing ID %, but this sign-up says % — check which is right, and clear the iRacing ID field to keep theirs',
        v_driver_name, v_existing_cust_id, p_iracing_cust_id;
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
        iracing_cust_id = coalesce(iracing_cust_id, p_iracing_cust_id),
        last_signed_up_at = now()
    where id = v_driver_id;
  end if;

  if v_current_number is null then
    -- Logan's number rule, including freeing it from an Inactive holder.
    perform public.set_driver_car_number(v_driver_id, v_number);
  end if;

  update public.signup_requests
  set status = 'approved',
      driver_id = v_driver_id,
      decided_by = auth.uid(),
      decided_at = now()
  where id = p_request_id;

  -- The roster name, which for a returning driver can differ from the sign-up's.
  select name into v_driver_name from public.drivers where id = v_driver_id;
  return jsonb_build_object('driver_id', v_driver_id, 'driver_name', v_driver_name, 'car_number', v_number);
end;
$$;

CREATE OR REPLACE FUNCTION "public"."reject_signup_request"("p_request_id" "uuid", "p_reason" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not is_admin() then
    raise exception 'Only an admin can reject sign-ups' using errcode = 'insufficient_privilege';
  end if;
  if length(v_reason) = 0 or length(v_reason) > 500 then
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

CREATE OR REPLACE FUNCTION "public"."pending_signup_rejections"() RETURNS TABLE("request_id" "uuid", "discord_user_id" "text", "name" "text", "reason" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select id, discord_user_id, name, reason
  from public.signup_requests
  where status = 'rejected' and notified_at is null
  order by decided_at;
$$;

CREATE OR REPLACE FUNCTION "public"."ack_signup_rejections"("p_request_ids" "uuid"[]) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_count integer;
begin
  update public.signup_requests
  set notified_at = now()
  where id = any (p_request_ids) and status = 'rejected' and notified_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- The sign-up table's original shape. No website or cancelled rows remain (checked above), so every
-- row satisfies the original status check and has a Discord id.
drop index public.signup_requests_requester_profile_id_idx;
drop index public.signup_requests_one_pending_per_requester;

alter table public.signup_requests drop constraint signup_requests_status_check;
alter table public.signup_requests drop constraint signup_requests_website_shape_check;
alter table public.signup_requests drop constraint signup_requests_discord_shape_check;
alter table public.signup_requests drop constraint signup_requests_requester_profile_id_fkey;
alter table public.signup_requests drop constraint signup_requests_source_check;

alter table public.signup_requests
  add constraint signup_requests_status_check
    check (status = any (array['pending'::text, 'approved'::text, 'rejected'::text]));

alter table public.signup_requests
  drop column requester_profile_id,
  drop column source;

alter table public.signup_requests alter column discord_user_id set not null;

drop index public.profiles_driver_id_unique;
