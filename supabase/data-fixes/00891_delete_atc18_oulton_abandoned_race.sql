-- Captured from the live database: this was applied directly to the Supabase project (as migration 20260922135555) and never had a file in the repo.
-- Added so the repo and the database's migration history agree, and so a from-scratch rebuild reproduces it. It sits at this number because it ran between the neighbouring migrations.

-- Remove the abandoned ATC18 Oulton Park race (subsession 88812671, 50
-- drivers, 0 laps completed -- the session that had to be restarted). No
-- other tables reference this subsession_id (verified: events,
-- penalties, race_links, race_scores, round_overrides, news_posts, and
-- manual_result_imports all have 0 matching rows), so only these three
-- need cleanup.
delete from curated_qualifying where subsession_id = 88812671;
delete from curated_race_results where subsession_id = 88812671;
delete from curated_rounds where subsession_id = 88812671;
