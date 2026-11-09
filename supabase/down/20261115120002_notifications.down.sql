-- Undoes 20261115120002_notifications.sql: drops the five notification triggers, the two site functions,
-- the trigger functions, the recipients helper and the notifications table, in reverse order, which returns
-- the schema to the polls state (20261115120001_polls.sql).
--
-- Data is lost: every in-site notification goes with the table. Revert the site code first, so nothing calls
-- the dropped functions. Undo this before the polls or appeals migrations, whose tables it references.

drop trigger polls_notify_schedule_vote on public.polls;
drop trigger incident_appeals_notify_closed on public.incident_appeals;
drop trigger round_incident_status_notify_posted on public.round_incident_status;
drop trigger curated_race_results_notify_results on public.curated_race_results;
drop trigger curated_rounds_notify_linked on public.curated_rounds;

drop function public.open_my_notifications();
drop function public.notification_unread_count();

drop function private.notify_schedule_vote();
drop function private.notify_appeal_closed();
drop function private.notify_report_posted();
drop function private.notify_results_added();
drop function private.notify_round_linked();
drop function private.notify_round_participants(bigint, integer[]);

drop table public.notifications;
