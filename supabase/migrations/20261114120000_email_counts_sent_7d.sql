-- Email counts: add "sent in the last 7 days" (FR5.7; BR5.13, BR5.14; NFR1, NFR2).
--
-- The admin dashboard's email figures gain a fifth tile, the number of emails actually sent in the last
-- 7 days. The figure comes from the existing admin-only definer function notifications_admin_counts(), so
-- email_outbox stays closed to signed-in callers. The function is replaced in place with the same body,
-- admin check, volatility and empty search_path, plus one new key, 'sent_7d': outbox rows with status
-- 'sent' and a sent_at within the last 7 days (sent rows are kept for 30 days, so the window is complete).
--
-- Expand only: the code on main ignores the extra key, so it keeps working while this applies.
-- Down script: supabase/down/20261114120000_email_counts_sent_7d.down.sql restores the previous body.

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
    'sent_7d', (select count(*) from public.email_outbox o
                where o.status = 'sent' and o.sent_at > now() - interval '7 days'),
    'last_run_status', v_last_status,
    'last_run_at', v_last_at);
end;
$$;

-- Replacing in place keeps the existing grants; re-stated so the function stays signed-in only.
revoke all on function public.notifications_admin_counts() from public, anon;
grant execute on function public.notifications_admin_counts() to authenticated;
