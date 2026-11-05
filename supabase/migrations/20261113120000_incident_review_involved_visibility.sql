-- Steward reviews stay hidden from a steward involved in the incident until it is decided (FR1.1, NFR2;
-- rules BR1.1 and BR1.6 of the incident review design).
--
-- What:
--   * "admin read incident_report_reviews" is replaced. A steward still reads their own review, and an
--     uninvolved steward still reads everyone's once they have reviewed or the report has been added to the
--     incident report (reviews_closed_at set), as before. A steward linked to one of the report's drivers no
--     longer reads the others' reviews while the report is open: only once reviews_closed_at is set or the
--     report is dismissed. Reopening a dismissed report hides them again. The faults table
--     (incident_report_review_drivers) follows automatically, because its policy checks that the review is
--     readable.
--   * private.refuse_involved_status_change() and a BEFORE UPDATE OF status trigger on incident_reports refuse
--     a status change (log, dismiss, reopen) by a signed-in steward involved in the report, raising
--     'INVOLVED_STEWARD: ...'. Without it an involved steward could dismiss their own report to read the
--     reviews and then reopen it. Service-role and SQL-editor updates (no auth.uid()) are unaffected.
--
-- Why in the database: who may read reviews is an access rule (team rule), so a steward querying the table
-- with their own session gets the same answer as the page. The review count keeps coming from the existing
-- definer function incident_report_review_counts, so the page still shows "Steward Reviews: N".
--
-- Expand-safe: the policy only narrows reads and the trigger only refuses an action the new page no longer
-- offers involved stewards, so the code on main keeps working (it shows an empty review area instead of the
-- reviews). Undo with supabase/down/20261113120000_incident_review_involved_visibility.down.sql.

-- 1. Review read policy (BR1.1) ---------------------------------------------------------------------------
drop policy "admin read incident_report_reviews" on public.incident_report_reviews;

create policy "admin read incident_report_reviews" on public.incident_report_reviews
  for select
  using (
    (select public.is_admin())
    and (
      reviewer_id = (select auth.uid())
      or exists (
        select 1
        from public.incident_reports r
        where r.id = incident_report_reviews.report_id
          and (
            r.reviews_closed_at is not null
            or (r.status = 'dismissed' and public.is_involved_in_incident_report(r.id))
          )
      )
      or (
        not public.is_involved_in_incident_report(report_id)
        and public.has_reviewed_incident_report(report_id)
      )
    )
  );

-- 2. Involved stewards cannot change the report's status (BR1.6) ------------------------------------------
create function private.refuse_involved_status_change() returns trigger
  language plpgsql security definer
  set search_path = ''
  as $$
begin
  if auth.uid() is not null and public.is_involved_in_incident_report(new.id) then
    raise exception 'INVOLVED_STEWARD: You are involved in this incident, so another steward must decide it.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function private.refuse_involved_status_change() is
  'Before a status change on incident_reports: refuses it when the signed-in caller is linked to one of the report''s drivers, so an involved steward cannot reveal the reviews to themselves (BR1.6).';

revoke all on function private.refuse_involved_status_change() from public, anon, authenticated, service_role;

-- Named to sort before incident_reports_stamp_reviews_closed, so a refused change never stamps anything.
create trigger incident_reports_refuse_involved_status_change
  before update of status on public.incident_reports
  for each row
  when (old.status is distinct from new.status)
  execute function private.refuse_involved_status_change();
