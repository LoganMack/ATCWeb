-- Undoes 20261110120000_incident_submissions.sql: drops the public submissions list.

drop function public.incident_submissions(bigint);
