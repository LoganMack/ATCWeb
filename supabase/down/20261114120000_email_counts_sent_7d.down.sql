-- Down script for 20261114120000_email_counts_sent_7d.sql: restores notifications_admin_counts() exactly as
-- 20261031120000_email_notifications.sql created it (without 'sent_7d'), with the same grants.

create or replace function public.notifications_admin_counts() returns jsonb
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

revoke all on function public.notifications_admin_counts() from public, anon;
grant execute on function public.notifications_admin_counts() to authenticated;
