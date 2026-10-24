-- Email notifications (U7 email-notifications, US6.2-US6.5, AC6.1.3; contracts C3, C7, C8, C9; rules
-- BR10.1-BR10.20 with their NFR amendments; ADR-002, ADR-006).
--
-- What: an outbox of emails to send (email_outbox), a record of enqueue failures (email_enqueue_failures)
-- and a short log of the scheduled runs (notification_runs). Three triggers fill the outbox:
--   * an appeal set to 'reviewed' queues one "Appeal Marked Reviewed" email for its submitter;
--   * the first time a round's incident report is posted, every linked account whose driver raced in it
--     gets one "Incident Report Posted" email (round_incident_status gains first_posted_at, set once);
--   * the Worker's cron run queues "Event Reminders" 12 hours before a championship event's first session.
-- Only accounts that turned the matching toggle on in account_settings get an email.
-- The Worker (src/lib/notifications, every 15 minutes) drains the outbox through the
-- public.notifications_* functions below, which only the service role can execute, and sends through
-- Resend with an idempotency key per batch.
--
-- Why in the database: exactly-once queueing is a unique dedupe key per kind, subject and account, so a
-- repeated review, a re-post or an overlapping run can never queue a second email. The daily cap is
-- counted under an advisory lock, so overlapping runs cannot claim past it together. The outbox never
-- holds an email address: the claim functions read the current confirmed address from auth.users as their
-- owner and return it only in their result. Triggers never fail the admin action that fired them; a
-- failed enqueue is written to email_enqueue_failures and reported on the admin home.
--
-- Expand only: nothing existing changes except the new nullable column first_posted_at, which is
-- backfilled for rounds already posted before the triggers exist, so no old round ever sends. The code on
-- main keeps working while this applies. Undo with supabase/down/20261031120000_email_notifications.down.sql
-- (and remove the cron trigger from wrangler.jsonc).

-- 1. The outbox (BR10.2, BR10.9, BR10.18; NFR1.1, NFR3.5) ---------------------------------------------
create table public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('appeal_reviewed', 'report_posted', 'event_reminder')),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  subject_id text not null,
  dedupe_key text not null unique,
  payload jsonb not null,
  rendered jsonb,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'dropped', 'unknown')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  dropped_reason text check (dropped_reason in ('expired', 'toggle_off', 'no_confirmed_address', 'event_started',
                                               'event_moved', 'rejected', 'stale_unknown', 'cap_expired')),
  claim_token uuid,
  claimed_at timestamptz,
  first_claimed_at timestamptz,
  send_by timestamptz not null,
  provider_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  finished_at timestamptz
);

comment on table public.email_outbox is
  'Emails waiting to be sent or recently finished (U7). Never holds an email address or the Resend key; '
  'only the service role and the notifications_* definer functions reach it.';
comment on column public.email_outbox.payload is
  'The values the email needs (labels, ids, an event''s start time); never an address.';
comment on column public.email_outbox.rendered is
  'Subject, html and text, stored at first claim so a re-send under the same idempotency key is identical.';
comment on column public.email_outbox.finished_at is
  'When the row reached sent, dropped or unknown; drives the 7-day admin counts and retention.';

create index email_outbox_status_created_idx on public.email_outbox (status, created_at);
create index email_outbox_sending_claim_idx on public.email_outbox (claim_token) where status = 'sending';
create index email_outbox_sent_subject_idx on public.email_outbox (kind, subject_id, profile_id) where status = 'sent';
create index email_outbox_profile_idx on public.email_outbox (profile_id);

-- 2. Enqueue failures and run log (BR10.5, BR10.17, BR10.19; NFR9.1, NFR9.3) ------------------------------
create table public.email_enqueue_failures (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('appeal_reviewed', 'report_posted')),
  subject_id text not null,
  error text not null,
  created_at timestamptz not null default now()
);

comment on table public.email_enqueue_failures is
  'A trigger that could not queue its email (U7, BR10.5). The admin action still committed; not retried.';

create table public.notification_runs (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz not null default now(),
  status text not null check (status in ('ok', 'no_key', 'partial')),
  summary jsonb not null default '{}'::jsonb,
  quota_until timestamptz
);

comment on table public.notification_runs is
  'One row per scheduled run (U7): the summary the Worker logged, for the admin banner. Kept 30 days.';
comment on column public.notification_runs.quota_until is
  'Set when Resend reported its daily quota: claims return nothing until this time (next UTC midnight).';

create index notification_runs_ran_at_idx on public.notification_runs (ran_at);

-- Supabase grants every new public table to anon and authenticated by default, so start from nothing.
-- No policies: only the service role (which bypasses RLS) and the definer functions below reach them.
alter table public.email_outbox enable row level security;
alter table public.email_enqueue_failures enable row level security;
alter table public.notification_runs enable row level security;
revoke all on table public.email_outbox from public, anon, authenticated;
revoke all on table public.email_enqueue_failures from public, anon, authenticated;
revoke all on table public.notification_runs from public, anon, authenticated;

-- 3. First posting time (BR10.3, BR10.4; C7) ------------------------------------------------------------
--    Backfilled before the triggers exist, so rounds already posted never send.
alter table public.round_incident_status add column first_posted_at timestamptz;

comment on column public.round_incident_status.first_posted_at is
  'When the round''s incident report was first posted; set once by a trigger and never cleared (U7, C7).';

-- The backfill must not move updated_at: round_stats_status compares it with the stored round stats, and
-- a newer posting status would mark every posted round's stats as stale.
alter table public.round_incident_status disable trigger round_incident_status_set_updated_at;
update public.round_incident_status
set first_posted_at = coalesce(posted_at, now())
where posted;
alter table public.round_incident_status enable trigger round_incident_status_set_updated_at;

-- 4. An event's first session as a real instant (BR10.6, NFR4.8) ------------------------------------------
--    Session times are bare Eastern wall-clock times; the zone conversion uses that date's offset, so a
--    daylight-saving change is handled. Null when no session time is set.
create function private.notifications_event_starts_at(
  p_event_date date, p_practice time, p_qualifying time, p_race1 time, p_race2 time, p_race3 time)
  returns timestamptz
  language sql stable
  set search_path = ''
  as $$
  select (p_event_date + least(p_practice, p_qualifying, p_race1, p_race2, p_race3)) at time zone 'America/New_York';
$$;

revoke all on function private.notifications_event_starts_at(date, time, time, time, time, time)
  from public, anon, authenticated, service_role;

-- 5. Triggers (BR10.1-BR10.5; NFR1.5) ---------------------------------------------------------------------
--    Definer functions in private (not exposed by PostgREST). An enqueue error is caught in its own block:
--    a failure row is written (in a nested block of its own) and a warning raised, and the admin's
--    statement commits.

-- The site's setRoundPosted is a PostgREST upsert, so a first post is usually an INSERT. The value is
-- only ever set here: never by a client, never cleared on unpost.
create function private.round_first_posted() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
begin
  if tg_op = 'INSERT' then
    new.first_posted_at := case when new.posted then now() end;
  else
    new.first_posted_at := coalesce(old.first_posted_at, case when new.posted then now() end);
  end if;
  return new;
end;
$$;

create function private.enqueue_report_posted() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
begin
  if not ((tg_op = 'INSERT' and new.first_posted_at is not null)
          or (tg_op = 'UPDATE' and old.first_posted_at is null and new.first_posted_at is not null)) then
    return null;
  end if;

  begin
    insert into public.email_outbox (kind, profile_id, subject_id, dedupe_key, payload, send_by)
    select 'report_posted', rc.profile_id, new.subsession_id::text,
           'report_posted:' || new.subsession_id || ':' || rc.profile_id,
           jsonb_build_object(
             'subsession_id', new.subsession_id,
             'season_label', coalesce(se.name, cr.season_label),
             'round_number', cr.round_number,
             'track_name', cr.track_name),
           now() + interval '24 hours'
    from (
      select distinct p.id as profile_id
      from public.curated_race_results r
      join public.drivers d on d.iracing_cust_id = r.cust_id
      join public.profiles p on p.driver_id = d.id
      join public.account_settings s on s.profile_id = p.id and s.notify_report_posted
      where r.subsession_id = new.subsession_id
    ) rc
    left join public.curated_rounds cr on cr.subsession_id = new.subsession_id
    left join public.seasons se on se.id = cr.season_id
    on conflict (dedupe_key) do nothing;
  exception when others then
    begin
      insert into public.email_enqueue_failures (kind, subject_id, error)
      values ('report_posted', new.subsession_id::text, left(sqlstate || ': ' || sqlerrm, 500));
    exception when others then
      raise warning 'email enqueue failure for round % could not be recorded: %', new.subsession_id, sqlerrm;
    end;
    raise warning 'email enqueue failed for round %: %', new.subsession_id, sqlerrm;
  end;
  return null;
end;
$$;

create function private.enqueue_appeal_reviewed() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
begin
  begin
    insert into public.email_outbox (kind, profile_id, subject_id, dedupe_key, payload, send_by)
    select 'appeal_reviewed', p.id, new.id::text,
           'appeal_reviewed:' || new.id || ':' || p.id,
           jsonb_build_object(
             'appeal_id', new.id,
             'subsession_id', new.subsession_id,
             'season_label', coalesce(se.name, cr.season_label),
             'round_number', cr.round_number,
             'track_name', cr.track_name),
           now() + interval '24 hours'
    from public.profiles p
    join public.account_settings s on s.profile_id = p.id and s.notify_appeal_reviewed
    left join public.curated_rounds cr on cr.subsession_id = new.subsession_id
    left join public.seasons se on se.id = cr.season_id
    where p.id = new.submitter_id
    on conflict (dedupe_key) do nothing;
  exception when others then
    begin
      insert into public.email_enqueue_failures (kind, subject_id, error)
      values ('appeal_reviewed', new.id::text, left(sqlstate || ': ' || sqlerrm, 500));
    exception when others then
      raise warning 'email enqueue failure for appeal % could not be recorded: %', new.id, sqlerrm;
    end;
    raise warning 'email enqueue failed for appeal %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function private.round_first_posted() from public, anon, authenticated, service_role;
revoke all on function private.enqueue_report_posted() from public, anon, authenticated, service_role;
revoke all on function private.enqueue_appeal_reviewed() from public, anon, authenticated, service_role;

create trigger round_incident_status_first_posted
  before insert or update on public.round_incident_status
  for each row execute function private.round_first_posted();

create trigger round_incident_status_enqueue_report_posted
  after insert or update on public.round_incident_status
  for each row execute function private.enqueue_report_posted();

create trigger incident_appeals_enqueue_reviewed
  after update of status on public.incident_appeals
  for each row
  when (new.status = 'reviewed' and old.status is distinct from 'reviewed')
  execute function private.enqueue_appeal_reviewed();

-- 6. Worker functions (BR10.6-BR10.13, BR10.18; NFR1.2, NFR1.3, NFR4.3-NFR4.5) -------------------------------
--    Each is SECURITY DEFINER with an empty search_path and executable only by service_role. Results are
--    jsonb so the Worker reads one value per call. Only claim and take-stale return addresses.

-- Reminders: one per linked account with "Event Reminders" on, for each championship event whose first
-- session is 11 h 45 min to 12 h away. The key holds the start time, so a moved event can queue again;
-- once a reminder for an event was sent to an account, that account gets no follow-up (BR10.7).
create function public.notifications_enqueue_reminders() returns jsonb
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_enqueued integer;
  v_missed jsonb;
begin
  with due as (
    select e.id as event_id, x.starts_at, e.round_number,
           coalesce(c.name, e.title) as event_name, se.name as season_label
    from public.events e
    cross join lateral (
      select private.notifications_event_starts_at(e.event_date, e.practice_start_time, e.qualifying_start_time,
                                                   e.race1_start_time, e.race2_start_time, e.race3_start_time)
             as starts_at) x
    left join public.circuits c on c.id = e.circuit_id
    left join public.seasons se on se.id = e.season_id
    where e.category = 'championship'
      and x.starts_at > now() + interval '11 hours 45 minutes'
      and x.starts_at <= now() + interval '12 hours'
  ), inserted as (
    insert into public.email_outbox (kind, profile_id, subject_id, dedupe_key, payload, send_by)
    select 'event_reminder', p.id, d.event_id::text,
           'event_reminder:' || d.event_id || ':' || extract(epoch from d.starts_at)::bigint || ':' || p.id,
           jsonb_build_object(
             'event_id', d.event_id,
             'event_name', d.event_name,
             'season_label', d.season_label,
             'round_number', d.round_number,
             'starts_at', d.starts_at),
           least(now() + interval '24 hours', d.starts_at)
    from due d
    cross join public.account_settings s
    join public.profiles p on p.id = s.profile_id and p.driver_id is not null
    where s.notify_event_reminders
      and not exists (
        select 1 from public.email_outbox o
        where o.kind = 'event_reminder' and o.subject_id = d.event_id::text and o.profile_id = p.id
          and o.status = 'sent')
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select count(*) into v_enqueued from inserted;

  -- Windows that closed in the last 15 minutes with no reminder row, while someone wanted reminders.
  select coalesce(jsonb_agg(m.event_id order by m.event_id), '[]'::jsonb) into v_missed
  from (
    select e.id as event_id
    from public.events e
    cross join lateral (
      select private.notifications_event_starts_at(e.event_date, e.practice_start_time, e.qualifying_start_time,
                                                   e.race1_start_time, e.race2_start_time, e.race3_start_time)
             as starts_at) x
    where e.category = 'championship'
      and x.starts_at > now() + interval '11 hours 30 minutes'
      and x.starts_at <= now() + interval '11 hours 45 minutes'
      and not exists (select 1 from public.email_outbox o
                      where o.kind = 'event_reminder' and o.subject_id = e.id::text)
      and exists (select 1 from public.account_settings s
                  join public.profiles p on p.id = s.profile_id
                  where s.notify_event_reminders and p.driver_id is not null)
  ) m;

  return jsonb_build_object('enqueued', v_enqueued, 'missed_windows', v_missed);
end;
$$;

-- Queued rows past their send-by time drop (BR10.11), with cap_expired when the daily cap or Resend's
-- quota held them back; then retention: finished rows after 30 days, appeal_reviewed after 365 days (so a
-- re-reviewed appeal never emails twice within a season), runs and enqueue failures after 30 days.
create function public.notifications_drop_expired(p_daily_cap integer) returns jsonb
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_cap_hit boolean;
  v_dropped jsonb;
  v_deleted integer;
begin
  v_cap_hit := (select count(*) from public.email_outbox o
                where o.status = 'sent' and o.sent_at > now() - interval '24 hours') >= coalesce(p_daily_cap, 0)
               or exists (select 1 from public.notification_runs r
                          where r.quota_until > now() - interval '24 hours');

  with dropped as (
    update public.email_outbox o
    set status = 'dropped',
        dropped_reason = case
          when o.kind = 'event_reminder' and (o.payload ->> 'starts_at')::timestamptz <= now() then 'event_started'
          when v_cap_hit then 'cap_expired'
          else 'expired'
        end,
        finished_at = now()
    where o.status = 'queued' and o.send_by < now()
    returning o.id, o.kind, o.profile_id, o.dropped_reason
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'profile_id', d.profile_id,
                                               'reason', d.dropped_reason) order by d.id), '[]'::jsonb)
  into v_dropped
  from dropped d;

  delete from public.email_outbox o
  where o.status in ('sent', 'dropped', 'unknown')
    and coalesce(o.finished_at, o.created_at)
        < now() - case when o.kind = 'appeal_reviewed' then interval '365 days' else interval '30 days' end;
  get diagnostics v_deleted = row_count;

  delete from public.notification_runs r where r.ran_at < now() - interval '30 days';
  delete from public.email_enqueue_failures f where f.created_at < now() - interval '30 days';

  return jsonb_build_object('dropped', v_dropped, 'retention_deleted', v_deleted);
end;
$$;

-- The oldest batch that has sat in 'sending' for more than 10 minutes (its outcome is unknown), for the
-- Worker to send again unchanged under its original key. Before that: batches first claimed more than 20
-- hours ago drop as stale_unknown (Resend keeps keys for 24 hours). A batch with a row never rendered was
-- never sent, so it goes back to queued; one whose recipient no longer has a confirmed address cannot be
-- re-sent identically, so all its rows become unknown. Re-sends are serialized by an advisory lock.
create function public.notifications_take_stale_batch() returns jsonb
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_stale_unknown jsonb;
  v_batch uuid;
  v_total integer;
  v_unrendered integer;
  v_unaddressed integer;
  v_rows jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('email_outbox_stale'));

  with gone as (
    update public.email_outbox o
    set status = 'dropped', dropped_reason = 'stale_unknown', finished_at = now()
    where o.status = 'sending' and o.first_claimed_at < now() - interval '20 hours'
    returning o.id, o.kind, o.profile_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'kind', g.kind, 'profile_id', g.profile_id,
                                               'reason', 'stale_unknown') order by g.id), '[]'::jsonb)
  into v_stale_unknown
  from gone g;

  select o.claim_token into v_batch
  from public.email_outbox o
  where o.status = 'sending' and o.claim_token is not null and o.claimed_at < now() - interval '10 minutes'
  group by o.claim_token
  order by min(o.claimed_at), o.claim_token
  limit 1;

  if v_batch is null then
    return jsonb_build_object('batch_id', null, 'rows', '[]'::jsonb, 'stale_unknown', v_stale_unknown,
                              'released', 0, 'address_changed', 0);
  end if;

  select count(*),
         count(*) filter (where o.rendered is null),
         count(*) filter (where u.id is null or u.email is null or u.email_confirmed_at is null)
  into v_total, v_unrendered, v_unaddressed
  from public.email_outbox o
  left join auth.users u on u.id = o.profile_id
  where o.claim_token = v_batch and o.status = 'sending';

  if v_unrendered > 0 then
    update public.email_outbox o
    set status = 'queued', claim_token = null, claimed_at = null, first_claimed_at = null, rendered = null
    where o.claim_token = v_batch and o.status = 'sending';
    return jsonb_build_object('batch_id', null, 'rows', '[]'::jsonb, 'stale_unknown', v_stale_unknown,
                              'released', v_total, 'address_changed', 0);
  end if;

  if v_unaddressed > 0 then
    update public.email_outbox o
    set status = 'unknown', last_error = 'address_changed', finished_at = now()
    where o.claim_token = v_batch and o.status = 'sending';
    return jsonb_build_object('batch_id', null, 'rows', '[]'::jsonb, 'stale_unknown', v_stale_unknown,
                              'released', 0, 'address_changed', v_total);
  end if;

  -- Fresh claimed_at: another run will not pick this batch for the next 10 minutes.
  update public.email_outbox o set claimed_at = now()
  where o.claim_token = v_batch and o.status = 'sending';

  select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'kind', o.kind, 'profile_id', o.profile_id,
                                               'rendered', o.rendered, 'to', u.email) order by o.id), '[]'::jsonb)
  into v_rows
  from public.email_outbox o
  join auth.users u on u.id = o.profile_id
  where o.claim_token = v_batch and o.status = 'sending';

  return jsonb_build_object('batch_id', v_batch, 'rows', v_rows, 'stale_unknown', v_stale_unknown,
                            'released', 0, 'address_changed', 0);
end;
$$;

-- Claims up to one batch (BR10.8-BR10.10, BR10.12). Under an advisory lock held to the end of the call:
-- re-checks every queued email (toggle on, confirmed address, a reminder's event unmoved) and drops the
-- ones that fail; computes the cap left from rows sent since midnight UTC plus rows in a live claim; takes
-- the highest attempt level present, in batches of max(1, batch size / 2^level), oldest first. Returns the
-- rows ordered by id, each with its current confirmed address.
create function public.notifications_claim_batch(p_batch_id uuid, p_batch_size integer, p_daily_cap integer)
  returns jsonb
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_day_start timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  v_dropped jsonb;
  v_used integer;
  v_cap_left integer;
  v_level integer;
  v_size integer;
  v_claimed integer;
  v_rows jsonb;
begin
  if p_batch_id is null or p_batch_size is null or p_batch_size < 1 or p_batch_size > 100
     or p_daily_cap is null or p_daily_cap < 0 then
    raise exception 'INVALID: a batch id, a batch size from 1 to 100 and a daily cap of 0 or more are required'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('email_outbox_claim'));

  with checked as (
    select o.id,
           case
             when not coalesce(case o.kind
                                 when 'appeal_reviewed' then s.notify_appeal_reviewed
                                 when 'report_posted' then s.notify_report_posted
                                 when 'event_reminder' then s.notify_event_reminders
                               end, false) then 'toggle_off'
             when u.email is null or u.email_confirmed_at is null then 'no_confirmed_address'
             when o.kind = 'event_reminder'
                  and (e.id is null or x.starts_at is null
                       or x.starts_at is distinct from (o.payload ->> 'starts_at')::timestamptz) then 'event_moved'
           end as reason
    from public.email_outbox o
    left join public.account_settings s on s.profile_id = o.profile_id
    left join auth.users u on u.id = o.profile_id
    left join public.events e on o.kind = 'event_reminder' and e.id::text = o.subject_id
    left join lateral (
      select private.notifications_event_starts_at(e.event_date, e.practice_start_time, e.qualifying_start_time,
                                                   e.race1_start_time, e.race2_start_time, e.race3_start_time)
             as starts_at) x on true
    where o.status = 'queued'
  ), dropped as (
    update public.email_outbox o
    set status = 'dropped', dropped_reason = c.reason, finished_at = now()
    from checked c
    where c.id = o.id and c.reason is not null
    returning o.id, o.kind, o.profile_id, o.dropped_reason
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'profile_id', d.profile_id,
                                               'reason', d.dropped_reason) order by d.id), '[]'::jsonb)
  into v_dropped
  from dropped d;

  -- Resend reported its daily quota: nothing is claimed until the marker passes.
  if exists (select 1 from public.notification_runs r where r.quota_until > now()) then
    return jsonb_build_object('batch_id', p_batch_id, 'rows', '[]'::jsonb, 'dropped', v_dropped,
                              'cap_left', 0, 'level', null, 'quota_paused', true);
  end if;

  select count(*) into v_used
  from public.email_outbox o
  where (o.status = 'sent' and o.sent_at >= v_day_start)
     or (o.status = 'sending' and o.claimed_at >= now() - interval '10 minutes');
  v_cap_left := greatest(p_daily_cap - v_used, 0);

  select max(o.attempts) into v_level
  from public.email_outbox o
  where o.status = 'queued' and o.send_by >= now();

  if v_level is null or v_cap_left = 0 then
    return jsonb_build_object('batch_id', p_batch_id, 'rows', '[]'::jsonb, 'dropped', v_dropped,
                              'cap_left', v_cap_left, 'level', v_level, 'quota_paused', false);
  end if;

  v_size := least(greatest(1, floor(p_batch_size / power(2, least(v_level, 20)))::integer), v_cap_left);

  with picked as (
    select o.id
    from public.email_outbox o
    where o.status = 'queued' and o.attempts = v_level and o.send_by >= now()
    order by o.created_at, o.id
    limit v_size
    for update skip locked
  ), claimed as (
    update public.email_outbox o
    set status = 'sending', claim_token = p_batch_id, claimed_at = now(),
        first_claimed_at = coalesce(o.first_claimed_at, now())
    from picked p
    where o.id = p.id
    returning o.id, o.kind, o.profile_id, o.payload
  )
  select count(*),
         coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'profile_id', c.profile_id,
                                               'payload', c.payload, 'to', u.email) order by c.id), '[]'::jsonb)
  into v_claimed, v_rows
  from claimed c
  join auth.users u on u.id = c.profile_id;

  return jsonb_build_object('batch_id', p_batch_id, 'rows', v_rows, 'dropped', v_dropped,
                            'cap_left', v_cap_left - v_claimed, 'level', v_level, 'quota_paused', false);
end;
$$;

-- Stores each claimed row's rendering (subject, html, text; never an address) before the Resend call, so
-- a crash after the call re-sends identical bytes. Only rows of this batch, only when not yet rendered.
-- The Worker sends only when the returned count equals its batch size.
create function public.notifications_store_rendered(p_batch_id uuid, p_rendered jsonb) returns integer
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_count integer;
begin
  update public.email_outbox o
  set rendered = r.rendered
  from jsonb_to_recordset(coalesce(p_rendered, '[]'::jsonb)) as r (id uuid, rendered jsonb)
  where o.id = r.id and o.claim_token = p_batch_id and o.status = 'sending' and o.rendered is null
    and r.rendered ? 'subject' and r.rendered ? 'html' and r.rendered ? 'text';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Applies a send outcome to the rows that still hold this batch id (BR10.9, BR10.12):
--   sent      -> sent, with each row's provider id
--   transient -> stays in sending under its id (timeout, network, 5xx, 429 rate limit, 409 in progress)
--   permanent -> back to queued with attempts + 1 and a clean claim; a batch of one drops as rejected
--   conflict  -> unknown (409 invalid_idempotent_request), never retried
--   release   -> back to queued with a clean claim and no attempt counted (daily quota, refused key)
create function public.notifications_mark_batch(p_batch_id uuid, p_result jsonb) returns jsonb
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_outcome text := p_result ->> 'outcome';
  v_error text := left(p_result ->> 'error', 200);
  v_rows integer;
  v_updated integer;
begin
  select count(*) into v_rows
  from public.email_outbox o
  where o.claim_token = p_batch_id and o.status = 'sending';

  if v_outcome = 'sent' then
    update public.email_outbox o
    set status = 'sent', sent_at = now(), finished_at = now(), last_error = null,
        provider_id = (select x.provider_id
                       from jsonb_to_recordset(coalesce(p_result -> 'provider_ids', '[]'::jsonb))
                            as x (id uuid, provider_id text)
                       where x.id = o.id
                       limit 1)
    where o.claim_token = p_batch_id and o.status = 'sending';
    get diagnostics v_updated = row_count;
  elsif v_outcome = 'transient' then
    update public.email_outbox o
    set last_error = v_error
    where o.claim_token = p_batch_id and o.status = 'sending';
    get diagnostics v_updated = row_count;
  elsif v_outcome = 'permanent' and v_rows = 1 then
    update public.email_outbox o
    set status = 'dropped', dropped_reason = 'rejected', last_error = v_error, finished_at = now()
    where o.claim_token = p_batch_id and o.status = 'sending';
    get diagnostics v_updated = row_count;
  elsif v_outcome = 'permanent' then
    update public.email_outbox o
    set status = 'queued', attempts = o.attempts + 1, last_error = v_error,
        claim_token = null, claimed_at = null, first_claimed_at = null, rendered = null
    where o.claim_token = p_batch_id and o.status = 'sending';
    get diagnostics v_updated = row_count;
  elsif v_outcome = 'conflict' then
    update public.email_outbox o
    set status = 'unknown', last_error = 'idempotent_conflict', finished_at = now()
    where o.claim_token = p_batch_id and o.status = 'sending';
    get diagnostics v_updated = row_count;
  elsif v_outcome = 'release' then
    update public.email_outbox o
    set status = 'queued', last_error = v_error,
        claim_token = null, claimed_at = null, first_claimed_at = null, rendered = null
    where o.claim_token = p_batch_id and o.status = 'sending';
    get diagnostics v_updated = row_count;
  else
    raise exception 'INVALID: unknown send outcome %', coalesce(v_outcome, '(none)') using errcode = '22023';
  end if;

  return jsonb_build_object('outcome', v_outcome, 'updated', v_updated);
end;
$$;

-- One row per run, written at the end of every run (no_key and empty runs included). A quota_until in
-- the summary pauses claims until that time.
create function public.notifications_record_run(p_summary jsonb) returns uuid
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_id uuid;
begin
  insert into public.notification_runs (status, summary, quota_until)
  values (coalesce(p_summary ->> 'status', 'partial'), coalesce(p_summary, '{}'::jsonb),
          nullif(p_summary ->> 'quota_until', '')::timestamptz)
  returning id into v_id;
  return v_id;
end;
$$;

-- 7. Admin counts (BR10.17; NFR1.4, NFR9.3) ----------------------------------------------------------------
create function public.notifications_admin_counts() returns jsonb
  language plpgsql stable security definer
  set search_path = ''
  as $$
declare
  v_last_status text;
  v_last_at timestamptz;
begin
  if not public.is_admin() then
    raise exception 'NOT_ADMIN: Only admins can read the email counts' using errcode = '42501';
  end if;

  select r.status, r.ran_at into v_last_status, v_last_at
  from public.notification_runs r
  order by r.ran_at desc, r.id desc
  limit 1;

  return jsonb_build_object(
    'queued', (select count(*) from public.email_outbox o where o.status in ('queued', 'sending')),
    'dropped_7d', (select count(*) from public.email_outbox o
                   where o.status = 'dropped' and o.dropped_reason is distinct from 'stale_unknown'
                     and o.finished_at > now() - interval '7 days'),
    'cap_dropped_7d', (select count(*) from public.email_outbox o
                       where o.status = 'dropped' and o.dropped_reason = 'cap_expired'
                         and o.finished_at > now() - interval '7 days'),
    'unknown_7d', (select count(*) from public.email_outbox o
                   where (o.status = 'unknown' or o.dropped_reason = 'stale_unknown')
                     and o.finished_at > now() - interval '7 days'),
    'enqueue_failures_7d', (select count(*) from public.email_enqueue_failures f
                            where f.created_at > now() - interval '7 days'),
    'last_run_status', v_last_status,
    'last_run_at', v_last_at);
end;
$$;

-- 8. Grants (BR10.18; NFR1.2, NFR1.4) ----------------------------------------------------------------------
--    Supabase grants every new public function to anon and authenticated by default, so revoke first.
revoke all on function public.notifications_enqueue_reminders() from public, anon, authenticated;
revoke all on function public.notifications_drop_expired(integer) from public, anon, authenticated;
revoke all on function public.notifications_take_stale_batch() from public, anon, authenticated;
revoke all on function public.notifications_claim_batch(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.notifications_store_rendered(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.notifications_mark_batch(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.notifications_record_run(jsonb) from public, anon, authenticated;
revoke all on function public.notifications_admin_counts() from public, anon;

grant execute on function public.notifications_enqueue_reminders() to service_role;
grant execute on function public.notifications_drop_expired(integer) to service_role;
grant execute on function public.notifications_take_stale_batch() to service_role;
grant execute on function public.notifications_claim_batch(uuid, integer, integer) to service_role;
grant execute on function public.notifications_store_rendered(uuid, jsonb) to service_role;
grant execute on function public.notifications_mark_batch(uuid, jsonb) to service_role;
grant execute on function public.notifications_record_run(jsonb) to service_role;
grant execute on function public.notifications_admin_counts() to authenticated;
