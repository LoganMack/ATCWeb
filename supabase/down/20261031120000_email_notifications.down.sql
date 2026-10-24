-- Undoes 20261031120000_email_notifications.sql: drops the three triggers and their functions, the
-- notifications_* functions, the event start helper, the outbox, enqueue-failure and run tables, and
-- round_incident_status.first_posted_at.
--
-- Every queued email, the sent history (which stops repeat emails) and the run log are lost. Before
-- running this, delete the RESEND_API_KEY secret or remove the cron trigger from wrangler.jsonc, so no
-- scheduled run calls the dropped functions. To keep the history, first export the tables in the SQL
-- editor (select * from public.email_outbox, then download the result as CSV).

drop trigger incident_appeals_enqueue_reviewed on public.incident_appeals;
drop trigger round_incident_status_enqueue_report_posted on public.round_incident_status;
drop trigger round_incident_status_first_posted on public.round_incident_status;

drop function private.enqueue_appeal_reviewed();
drop function private.enqueue_report_posted();
drop function private.round_first_posted();

drop function public.notifications_admin_counts();
drop function public.notifications_record_run(jsonb);
drop function public.notifications_mark_batch(uuid, jsonb);
drop function public.notifications_store_rendered(uuid, jsonb);
drop function public.notifications_claim_batch(uuid, integer, integer);
drop function public.notifications_take_stale_batch();
drop function public.notifications_drop_expired(integer);
drop function public.notifications_enqueue_reminders();
drop function private.notifications_event_starts_at(date, time, time, time, time, time);

drop table public.notification_runs;
drop table public.email_enqueue_failures;
drop table public.email_outbox;

alter table public.round_incident_status drop column first_posted_at;
