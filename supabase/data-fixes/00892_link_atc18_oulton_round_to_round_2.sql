-- Captured from the live database: this was applied directly to the Supabase project (as migration 20260922135601) and never had a file in the repo.
-- Added so the repo and the database's migration history agree, and so a from-scratch rebuild reproduces it. It sits at this number because it ran between the neighbouring migrations.

-- Link the good ATC18 Oulton Park race (subsession 88816236, 52 drivers,
-- 1446 laps completed) to ATC18 Round 2 (events.id
-- b52b5f67-8057-4082-ab37-aa668127782a, event_date 2026-09-21, circuit
-- Oulton Park Circuit / International layout -- matches). Events auto-link
-- to a curated_rounds row by season_id+round_number match (see
-- getEventRound() in src/lib/results.ts), so setting these two columns is
-- all that's needed -- no subsession_id override required on the event
-- itself.
update curated_rounds
set season_id = 'e2582051-2838-475d-bef9-3d6eb8e7f4e8', round_number = 2
where subsession_id = 88816236;
