-- Flags a drivers row as an AI-controlled entrant that exists only to
-- satisfy the FK relationships certain exhibition-round results need
-- (race_scores/curated_race_results link to a real drivers.id). Same shape
-- as is_hall_of_fame (0027_hall_of_fame.sql) — a plain boolean, admin-set
-- after the driver row already exists.
--
-- Application behavior (see src/lib/supabase.ts's getDrivers()/
-- getHallOfFameDrivers() and src/lib/results.ts's driversSelect()):
-- excluded by default everywhere except getRoundResults()/
-- getQualifyingForSubsession() (which explicitly opt back in so an AI
-- driver still resolves normally, not as a synthetic "not in roster" row,
-- on the specific exhibition round they raced in) and the admin Drivers
-- list's dedicated "AI" filter tab.
alter table public.drivers
  add column if not exists is_ai boolean not null default false;
