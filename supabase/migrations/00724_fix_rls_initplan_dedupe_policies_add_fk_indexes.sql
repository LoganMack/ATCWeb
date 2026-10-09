-- Captured from the live database: this was applied directly to the Supabase project (as migration 20260827211934) and never had a file in the repo.
-- Added so the repo and the database's migration history agree, and so a from-scratch rebuild reproduces it. It sits at this number because it ran between the neighbouring migrations.

-- === auth_rls_initplan: wrap auth.uid() so it's evaluated once per
-- statement instead of once per row (the 2 not already covered by the
-- policy-merge below) ===
ALTER POLICY "admin insert profiles" ON public.profiles
  WITH CHECK (is_admin() OR (select auth.uid()) = id);

ALTER POLICY "insert activity_log" ON public.activity_log
  WITH CHECK (is_admin() OR (select auth.uid()) = actor_id);

-- === multiple_permissive_policies: pure duplicate policies (same rule,
-- defined twice under different names) -- drop the redundant copy ===
DROP POLICY "admin delete results" ON public.curated_race_results;
DROP POLICY "admin insert results" ON public.curated_race_results;
DROP POLICY "admin update results" ON public.curated_race_results;

DROP POLICY "admin delete rounds" ON public.curated_rounds;
DROP POLICY "admin insert rounds" ON public.curated_rounds;
DROP POLICY "admin update rounds" ON public.curated_rounds;
DROP POLICY "public read rounds" ON public.curated_rounds;

DROP POLICY "admin delete scores" ON public.race_scores;
DROP POLICY "admin insert scores" ON public.race_scores;
DROP POLICY "admin update scores" ON public.race_scores;
DROP POLICY "public read scores" ON public.race_scores;

-- === multiple_permissive_policies: admin-only SELECT fully subsumed by an
-- unconditional "public read" (qual = true) policy on the same table --
-- true OR anything is always true, so the admin-only one adds nothing ===
DROP POLICY "admin read qualifying" ON public.curated_qualifying;
DROP POLICY "admin read results" ON public.curated_race_results;
DROP POLICY "admin read seasons" ON public.seasons;

-- === multiple_permissive_policies: genuinely different rules -- merge into
-- one policy with OR, preserving exactly the same access as before ===
DROP POLICY "admin read all news" ON public.news_posts;
DROP POLICY "public read published news" ON public.news_posts;
CREATE POLICY "read news" ON public.news_posts
  FOR SELECT
  USING (is_admin() OR status = 'published');

DROP POLICY "read all profiles as admin" ON public.profiles;
DROP POLICY "read own profile" ON public.profiles;
CREATE POLICY "read profile" ON public.profiles
  FOR SELECT
  USING (is_admin() OR (select auth.uid()) = id);

DROP POLICY "admin manage profiles" ON public.profiles;
DROP POLICY "update own profile" ON public.profiles;
CREATE POLICY "update profile" ON public.profiles
  FOR UPDATE
  USING (is_admin() OR (select auth.uid()) = id);

-- === unindexed_foreign_keys: additive, no behavior change ===
CREATE INDEX IF NOT EXISTS activity_log_actor_id_idx ON public.activity_log (actor_id);
CREATE INDEX IF NOT EXISTS champion_photos_class_id_idx ON public.champion_photos (class_id);
CREATE INDEX IF NOT EXISTS champion_photos_driver_id_idx ON public.champion_photos (driver_id);
CREATE INDEX IF NOT EXISTS driver_season_classes_class_id_idx ON public.driver_season_classes (class_id);
CREATE INDEX IF NOT EXISTS driver_season_classes_season_id_idx ON public.driver_season_classes (season_id);
CREATE INDEX IF NOT EXISTS drivers_created_by_idx ON public.drivers (created_by);
CREATE INDEX IF NOT EXISTS drivers_updated_by_idx ON public.drivers (updated_by);
CREATE INDEX IF NOT EXISTS events_subsession_id_idx ON public.events (subsession_id);
CREATE INDEX IF NOT EXISTS manual_awards_driver_id_idx ON public.manual_awards (driver_id);
CREATE INDEX IF NOT EXISTS news_post_tags_tag_id_idx ON public.news_post_tags (tag_id);
CREATE INDEX IF NOT EXISTS news_posts_season_id_idx ON public.news_posts (season_id);
CREATE INDEX IF NOT EXISTS penalty_involved_drivers_driver_id_idx ON public.penalty_involved_drivers (driver_id);
CREATE INDEX IF NOT EXISTS penalty_offense_links_offense_id_idx ON public.penalty_offense_links (offense_id);
CREATE INDEX IF NOT EXISTS profiles_driver_id_idx ON public.profiles (driver_id);
CREATE INDEX IF NOT EXISTS race_scores_class_id_idx ON public.race_scores (class_id);
CREATE INDEX IF NOT EXISTS race_scores_ruleset_id_idx ON public.race_scores (ruleset_id);
CREATE INDEX IF NOT EXISTS race_scores_team_id_idx ON public.race_scores (team_id);
CREATE INDEX IF NOT EXISTS team_rosters_driver_id_idx ON public.team_rosters (driver_id);
