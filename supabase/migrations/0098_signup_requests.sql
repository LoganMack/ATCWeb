-- Alpha Touring Challenge — Discord sign-up requests
--
-- Driver sign-ups arrive from the ATC Discord bot (/atcsignup) through the
-- bot API (src/pages/api/bot/), wait in signup_requests, and are approved or
-- rejected by an admin at Admin > Sign-ups. Approval creates or reactivates
-- the roster entry, so the website stays the single source of truth for the
-- roster and car numbers. Full design: docs/signup-integration.md.
--
-- Who can do what:
--   * The bot API (service role only — the endpoints check the bot's token
--     first): submit_signup_request(), pending_signup_rejections(),
--     ack_signup_rejections().
--   * Admins: read signup_requests (RLS), approve_signup_request(),
--     reject_signup_request().
--   * Nobody else, and no direct writes to the table at all.
--
-- Car numbers use the website's existing rule (set_driver_car_number(),
-- 0039): a number is free unless a driver whose status isn't Inactive holds
-- it, and approval assigns it through that same function.

-- 1. Re-sign-ups restart the inactivity clock --------------------------------
-- Set every time a sign-up for the driver is approved. sync_driver_statuses()
-- (section 5) measures inactivity from the later of this and the driver's
-- last race, so a returning driver approved today isn't flipped straight back
-- to Inactive by their old last race. sign_up_date keeps meaning "first
-- joined" and is never overwritten for a returning driver.
alter table public.drivers add column if not exists last_signed_up_at timestamptz;

comment on column public.drivers.last_signed_up_at is
  'When a Discord sign-up for this driver was last approved (0098). Restarts the inactivity clock in sync_driver_statuses().';

-- 2. The requests ---------------------------------------------------------------
create table if not exists public.signup_requests (
  id uuid primary key default gen_random_uuid(),
  -- Discord snowflakes exceed JS's safe integer range, so they're text.
  -- Stored only so the bot can DM a rejection — drivers are never linked to
  -- Discord accounts.
  discord_user_id text not null check (discord_user_id ~ '^[0-9]{1,25}$'),
  discord_username text,
  name text not null check (length(btrim(name)) between 1 and 80),
  iracing_cust_id bigint check (iracing_cust_id is null or iracing_cust_id > 0),
  -- Preference order: approval assigns the first one that's free.
  requested_numbers integer[] not null check (
    cardinality(requested_numbers) between 1 and 3
    and 0 <= all (requested_numbers) and 999 >= all (requested_numbers)
  ),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reason text check (reason is null or length(reason) <= 500),
  -- The roster entry created or reactivated on approval.
  driver_id uuid references public.drivers (id) on delete set null,
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  -- When the bot confirmed it DM'd the driver about a rejection.
  notified_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists signup_requests_status_idx on public.signup_requests (status, created_at);

-- At most one pending sign-up per Discord user (submit_signup_request()
-- replaces it); this is the backstop if two arrive at the same moment.
create unique index if not exists signup_requests_one_pending_per_user
  on public.signup_requests (discord_user_id) where status = 'pending';

alter table public.signup_requests enable row level security;

drop policy if exists "admin read signup_requests" on public.signup_requests;
create policy "admin read signup_requests" on public.signup_requests
  for select using (is_admin());

-- 3. Number availability ----------------------------------------------------------
-- Name of the driver blocking p_number for someone else: any driver holding
-- it whose status isn't Inactive (same rule as set_driver_car_number()). Null
-- when the number is free. p_exclude_driver_id skips the driver being
-- assigned, so a returning driver never blocks themselves.
create or replace function public.car_number_holder(p_number integer, p_exclude_driver_id uuid default null)
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select d.name
  from public.drivers d
  join public.driver_statuses ds on ds.id = d.status_id
  where d.car_number = p_number
    and ds.name <> 'Inactive'
    and (p_exclude_driver_id is null or d.id <> p_exclude_driver_id)
  limit 1;
$$;

revoke all on function public.car_number_holder(integer, uuid) from public, anon, authenticated;

-- 4. Bot API functions (service role only) --------------------------------------
-- Validates and saves a sign-up, or reports that every requested number is
-- taken (in which case nothing is saved). Returns:
--   { "status": "pending", "request_id": ..., "assigned_number": N, "taken": [...], "replaced_previous": bool }
--   { "status": "all_taken", "taken": [{ "number": N, "holder": "Name" }, ...] }
-- Invalid input raises an exception whose message starts with "invalid:",
-- which the API turns into a 400.
create or replace function public.submit_signup_request(
  p_discord_user_id text,
  p_discord_username text,
  p_name text,
  p_numbers integer[],
  p_iracing_cust_id bigint default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_number integer;
  v_holder text;
  v_assigned integer;
  v_taken jsonb := '[]'::jsonb;
  v_id uuid;
begin
  if p_discord_user_id is null or p_discord_user_id !~ '^[0-9]{1,25}$' then
    raise exception 'invalid: discord_user_id must be a Discord user ID';
  end if;
  if length(v_name) = 0 or length(v_name) > 80 then
    raise exception 'invalid: name must be 1-80 characters';
  end if;
  if p_numbers is null or cardinality(p_numbers) = 0 or cardinality(p_numbers) > 3 then
    raise exception 'invalid: give 1 to 3 numbers';
  end if;
  if exists (select 1 from unnest(p_numbers) n where n is null or n < 0 or n > 999) then
    raise exception 'invalid: numbers must be between 0 and 999';
  end if;
  if (select count(distinct n) from unnest(p_numbers) n) <> cardinality(p_numbers) then
    raise exception 'invalid: numbers must not repeat';
  end if;
  if p_iracing_cust_id is not null and p_iracing_cust_id <= 0 then
    raise exception 'invalid: iracing_id must be a positive number';
  end if;

  foreach v_number in array p_numbers loop
    -- Same rule as car_number_holder(), except a number held by the person
    -- signing up doesn't block them: a returning driver re-signing with
    -- their own number. "Same person" = same iRacing ID, or the same name
    -- when either side has no iRacing ID (the same test Admin > Sign-ups
    -- uses to suggest a returning driver).
    select d.name into v_holder
    from public.drivers d
    join public.driver_statuses ds on ds.id = d.status_id
    where d.car_number = v_number
      and ds.name <> 'Inactive'
      and not (
        (p_iracing_cust_id is not null and d.iracing_cust_id = p_iracing_cust_id)
        or (lower(d.name) = lower(v_name) and (p_iracing_cust_id is null or d.iracing_cust_id is null))
      )
    limit 1;
    if v_holder is null then
      v_assigned := v_number;
      exit;
    end if;
    v_taken := v_taken || jsonb_build_object('number', v_number, 'holder', v_holder);
    v_holder := null;
  end loop;

  if v_assigned is null then
    return jsonb_build_object('status', 'all_taken', 'taken', v_taken);
  end if;

  -- One pending sign-up per Discord user: signing up again replaces the
  -- pending one instead of queueing a duplicate.
  update public.signup_requests
  set discord_username = nullif(btrim(coalesce(p_discord_username, '')), ''),
      name = v_name,
      iracing_cust_id = p_iracing_cust_id,
      requested_numbers = p_numbers,
      created_at = now()
  where discord_user_id = p_discord_user_id and status = 'pending'
  returning id into v_id;

  if v_id is null then
    insert into public.signup_requests (discord_user_id, discord_username, name, iracing_cust_id, requested_numbers)
    values (p_discord_user_id, nullif(btrim(coalesce(p_discord_username, '')), ''), v_name, p_iracing_cust_id, p_numbers)
    returning id into v_id;
    return jsonb_build_object('status', 'pending', 'request_id', v_id, 'assigned_number', v_assigned, 'taken', v_taken, 'replaced_previous', false);
  end if;

  return jsonb_build_object('status', 'pending', 'request_id', v_id, 'assigned_number', v_assigned, 'taken', v_taken, 'replaced_previous', true);
end;
$$;

-- Rejections the bot hasn't confirmed DMing yet.
create or replace function public.pending_signup_rejections()
returns table (request_id uuid, discord_user_id text, name text, reason text)
language sql
stable
security definer
set search_path to 'public'
as $$
  select id, discord_user_id, name, reason
  from public.signup_requests
  where status = 'rejected' and notified_at is null
  order by decided_at;
$$;

-- Marks rejections as DM'd. Returns how many were marked.
create or replace function public.ack_signup_rejections(p_request_ids uuid[])
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
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

revoke all on function public.submit_signup_request(text, text, text, integer[], bigint) from public, anon, authenticated;
revoke all on function public.pending_signup_rejections() from public, anon, authenticated;
revoke all on function public.ack_signup_rejections(uuid[]) from public, anon, authenticated;
grant execute on function public.submit_signup_request(text, text, text, integer[], bigint) to service_role;
grant execute on function public.pending_signup_rejections() to service_role;
grant execute on function public.ack_signup_rejections(uuid[]) to service_role;

-- 5. Admin decisions ---------------------------------------------------------------
-- Approves a pending request. p_driver_id null = new driver; otherwise the
-- returning driver to reactivate. The admin's corrected name / iRacing ID and
-- chosen class are applied. Raises with a message fit to show the admin when
-- the request isn't pending, or none of its numbers is free any more.
-- Returns { "driver_id": ..., "driver_name": ..., "car_number": N }.
create or replace function public.approve_signup_request(
  p_request_id uuid,
  p_name text,
  p_iracing_cust_id bigint,
  p_class_id integer,
  p_driver_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
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

create or replace function public.reject_signup_request(p_request_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
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

revoke all on function public.approve_signup_request(uuid, text, bigint, integer, uuid) from public, anon;
revoke all on function public.reject_signup_request(uuid, text) from public, anon;
grant execute on function public.approve_signup_request(uuid, text, bigint, integer, uuid) to authenticated;
grant execute on function public.reject_signup_request(uuid, text) to authenticated;

-- 6. sync_driver_statuses(): inactivity from the later of last race and last sign-up
-- Same body as 0063_driver_never_raced_inactivity.sql, with two changes:
--   * raced-before branch: also requires both thresholds to have passed
--     since last_signed_up_at (when set), so an approved re-sign-up restarts
--     the clock;
--   * never-raced branch: measures from the later of sign_up_date and
--     last_signed_up_at instead of sign_up_date alone.
-- The Inactive -> Active branch is unchanged.
create or replace function public.sync_driver_statuses()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_active_id       integer;
  v_inactive_id     integer;
  v_changed         integer := 0;
  v_count           integer;
  v_inactivity_days integer;
  v_inactivity_rounds integer;
begin
  if not is_admin() then
    raise exception 'Only an admin can sync driver statuses'
      using errcode = 'insufficient_privilege';
  end if;

  select id into v_active_id from public.driver_statuses where name = 'Active';
  select id into v_inactive_id from public.driver_statuses where name = 'Inactive';
  if v_active_id is null or v_inactive_id is null then
    raise exception 'driver_statuses is missing Active/Inactive rows';
  end if;

  select coalesce((select value from public.site_settings where setting_key = 'inactivity_days')::integer, 90)
    into v_inactivity_days;
  select coalesce((select value from public.site_settings where setting_key = 'inactivity_rounds')::integer, 12)
    into v_inactivity_rounds;
  if v_inactivity_days is null or v_inactivity_days <= 0 then
    v_inactivity_days := 90;
  end if;
  if v_inactivity_rounds is null or v_inactivity_rounds <= 0 then
    v_inactivity_rounds := 12;
  end if;

  -- New/Active -> Inactive (has raced at least once): both thresholds have
  -- passed since their most recent race, and since their last approved
  -- sign-up if they have one.
  update public.drivers d
  set status_id = v_inactive_id
  from public.driver_statuses ds, public.driver_last_race lr
  where ds.id = d.status_id
    and lr.driver_id = d.id
    and ds.name in ('New', 'Active')
    and lr.last_race_at is not null
    and lr.last_race_at < now() - (v_inactivity_days || ' days')::interval
    and lr.rounds_since_last_race >= v_inactivity_rounds
    and (
      d.last_signed_up_at is null
      or (
        d.last_signed_up_at < now() - (v_inactivity_days || ' days')::interval
        and (
          select count(*)::integer
          from public.curated_rounds cr
          where cr.status = 'official'
            and cr.start_time > d.last_signed_up_at
        ) >= v_inactivity_rounds
      )
    );
  get diagnostics v_count = row_count;
  v_changed := v_changed + v_count;

  -- New -> Inactive (never raced at all): same two thresholds, measured
  -- from the later of sign_up_date and last_signed_up_at.
  update public.drivers d
  set status_id = v_inactive_id
  from public.driver_statuses ds, public.driver_last_race lr
  where ds.id = d.status_id
    and lr.driver_id = d.id
    and ds.name = 'New'
    and lr.last_race_at is null
    and greatest(d.sign_up_date::timestamptz, d.last_signed_up_at) is not null
    and greatest(d.sign_up_date::timestamptz, d.last_signed_up_at) < now() - (v_inactivity_days || ' days')::interval
    and (
      select count(*)::integer
      from public.curated_rounds cr
      where cr.status = 'official'
        and cr.start_time > greatest(d.sign_up_date::timestamptz, d.last_signed_up_at)
    ) >= v_inactivity_rounds;
  get diagnostics v_count = row_count;
  v_changed := v_changed + v_count;

  -- Inactive -> Active: logical complement of the raced-before rule
  -- (unchanged from 0063).
  update public.drivers d
  set status_id = v_active_id
  from public.driver_statuses ds, public.driver_last_race lr
  where ds.id = d.status_id
    and lr.driver_id = d.id
    and ds.name = 'Inactive'
    and lr.last_race_at is not null
    and not (
      lr.last_race_at < now() - (v_inactivity_days || ' days')::interval
      and lr.rounds_since_last_race >= v_inactivity_rounds
    );
  get diagnostics v_count = row_count;
  v_changed := v_changed + v_count;

  return v_changed;
end;
$$;
