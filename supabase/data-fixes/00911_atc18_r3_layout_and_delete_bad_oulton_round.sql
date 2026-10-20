-- Captured from the live database: this was applied directly to the Supabase project (as migration 20260929195911) and never had a file in the repo.
-- Added so the repo and the database's migration history agree, and so a from-scratch rebuild reproduces it. It sits at this number because it ran between the neighbouring migrations.

-- ATC18 Round 3 (Charlotte): set the layout to the one on its calendar event.
update curated_rounds
   set layout = 'Roval No Chicanes'
 where subsession_id = 88984251 and layout is null;

-- Remove the stray duplicate Oulton Park round (never linked to a season/round/event,
-- no scores, penalties, links or overrides). The real Round 2 is 88816236.
delete from curated_race_results where subsession_id = 88812671;
delete from curated_qualifying  where subsession_id = 88812671;
delete from curated_practice_results where subsession_id = 88812671;
delete from curated_rounds where subsession_id = 88812671 and season_id is null and event_id is null;
