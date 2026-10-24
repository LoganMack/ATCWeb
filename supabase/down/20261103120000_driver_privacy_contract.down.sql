-- Undoes 20261103120000_driver_privacy_contract.sql: drops the admin-only and author read policies, restores
-- the eleven tables' public select policies and the two dependent penalty policies with their baseline names
-- and expressions (copied verbatim from 20261020120000_baseline_schema.sql), then drops the helper.
--
-- No data is lost: the migration changed only policies and added one function. Afterwards the raw tables are
-- readable with the public key again, so hidden drivers are masked only on the site. Run this before
-- supabase/down/20261029120000_driver_privacy_views.down.sql.

drop policy "author read own kudos" on public.kudos;

drop policy "admin read drivers" on public.drivers;
drop policy "admin read curated_race_results" on public.curated_race_results;
drop policy "admin read curated_qualifying" on public.curated_qualifying;
drop policy "admin read curated_practice_results" on public.curated_practice_results;
drop policy "admin read circuit_layouts" on public.circuit_layouts;
drop policy "admin read champion_photos" on public.champion_photos;
drop policy "admin read hall_of_fame_photos" on public.hall_of_fame_photos;
drop policy "admin read kudos" on public.kudos;
drop policy "admin read news_posts" on public.news_posts;
drop policy "admin read penalties" on public.penalties;
drop policy "admin read round_penalties" on public.round_penalties;

CREATE POLICY "public read" ON "public"."drivers" FOR SELECT USING (true);
CREATE POLICY "public read" ON "public"."curated_race_results" FOR SELECT USING (true);
CREATE POLICY "public read" ON "public"."curated_qualifying" FOR SELECT USING (true);
CREATE POLICY "public read" ON "public"."curated_practice_results" FOR SELECT USING (true);
CREATE POLICY "public read" ON "public"."circuit_layouts" FOR SELECT USING (true);
CREATE POLICY "public read" ON "public"."champion_photos" FOR SELECT USING (true);
CREATE POLICY "public read" ON "public"."hall_of_fame_photos" FOR SELECT USING (true);
CREATE POLICY "public read kudos" ON "public"."kudos" FOR SELECT USING (true);
CREATE POLICY "read news" ON "public"."news_posts" FOR SELECT USING (("public"."is_admin"() OR ("status" = 'published'::"text")));

CREATE POLICY "posted or admin read penalties" ON "public"."penalties" FOR SELECT USING ((( SELECT "public"."is_admin"() AS "is_admin") OR (EXISTS ( SELECT 1
   FROM "public"."round_incident_status" "s"
  WHERE (("s"."subsession_id" = "penalties"."subsession_id") AND "s"."posted")))));

CREATE POLICY "posted or admin read round_penalties" ON "public"."round_penalties" FOR SELECT USING ((( SELECT "public"."is_admin"() AS "is_admin") OR (EXISTS ( SELECT 1
   FROM "public"."round_incident_status" "s"
  WHERE (("s"."subsession_id" = "round_penalties"."subsession_id") AND "s"."posted")))));

drop policy "posted or admin read penalty_involved_drivers" on public.penalty_involved_drivers;
CREATE POLICY "posted or admin read penalty_involved_drivers" ON "public"."penalty_involved_drivers" FOR SELECT USING ((( SELECT "public"."is_admin"() AS "is_admin") OR (EXISTS ( SELECT 1
   FROM ("public"."penalties" "p"
     JOIN "public"."round_incident_status" "s" ON (("s"."subsession_id" = "p"."subsession_id")))
  WHERE (("p"."id" = "penalty_involved_drivers"."penalty_id") AND "s"."posted")))));

drop policy "posted or admin read penalty_offense_links" on public.penalty_offense_links;
CREATE POLICY "posted or admin read penalty_offense_links" ON "public"."penalty_offense_links" FOR SELECT USING ((( SELECT "public"."is_admin"() AS "is_admin") OR (EXISTS ( SELECT 1
   FROM ("public"."penalties" "p"
     JOIN "public"."round_incident_status" "s" ON (("s"."subsession_id" = "p"."subsession_id")))
  WHERE (("p"."id" = "penalty_offense_links"."penalty_id") AND "s"."posted")))));

-- After the policies that call it.
drop function private.penalty_is_posted(uuid);
