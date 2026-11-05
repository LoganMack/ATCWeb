-- Undoes 20261113120000_incident_review_involved_visibility.sql: drops the status trigger and its function,
-- then restores the review read policy with its baseline text (copied verbatim from
-- 20261020120000_baseline_schema.sql), so an involved steward again reads the other stewards' reviews of an
-- open report and may again log, dismiss or reopen it.
--
-- No data changes. Revert the site code first, so the page stops hiding the status buttons for involved
-- stewards only once the database allows them again.

drop trigger incident_reports_refuse_involved_status_change on public.incident_reports;
drop function private.refuse_involved_status_change();

drop policy "admin read incident_report_reviews" on public.incident_report_reviews;

CREATE POLICY "admin read incident_report_reviews" ON "public"."incident_report_reviews" FOR SELECT USING (("public"."is_admin"() AND (("reviewer_id" = ( SELECT "auth"."uid"() AS "uid")) OR "public"."has_reviewed_incident_report"("report_id") OR "public"."is_involved_in_incident_report"("report_id") OR (EXISTS ( SELECT 1
   FROM "public"."incident_reports" "r"
  WHERE (("r"."id" = "incident_report_reviews"."report_id") AND ("r"."reviews_closed_at" IS NOT NULL)))))));
