-- Undoes 20261109120002_incident_report_edit.sql: drops the edit function. Edits already made, and their
-- activity-log rows, stay as they are.

drop function public.edit_incident_report_submission(uuid, text, integer, text, uuid[]);
