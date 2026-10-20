-- Alpha Touring Challenge — extend 0078's curated_rounds.event_id backfill
--
-- 0078 backfilled event_id using season_id+round_number matching (the same
-- path getEventRound() in results.ts already prefers) — but that only ever
-- covers 40 of 237 curated_rounds rows in practice: round_number is a field
-- "only ever populated for real pipeline imports" per that function's own
-- doc comment, and it turns out the real pipeline leaves it null on 197 of
-- 237 rows here (verified by querying subsession_id > 0, i.e. genuinely
-- real-pipeline rows, not the manual/synthetic importer — there are zero of
-- those in this database currently). That gap meant 0078's backfill only
-- linked 43 of 237 rounds, and the dashboard's new "missing race results"
-- count would have shown 187 events as missing a result even though most of
-- those already have real curated_race_results rows on file — they just
-- weren't reachable via round_number.
--
-- This migration adds a second, independent match for whatever 0078 didn't
-- already link: circuit name + the round's own start_time converted to the
-- league's local calendar date (start_time is UTC; events.event_date is a
-- plain league-local date — see src/lib/timezone.ts's LEAGUE_TIME_ZONE for
-- why every date-only comparison across this app converts through
-- America/New_York first, same as here). This is exactly the same
-- circuit+date identity raceResultsImport.ts's own CSV importers now use to
-- set event_id on NEW rounds going forward (see that file), so history and
-- new imports end up linked the same way.
--
-- Verified with a dry run before writing this: 174 additional rounds match
-- a circuit+date exactly, but 2 of those subsession_ids each match TWO
-- events on the same circuit+date (a genuine same-day ambiguity — e.g. two
-- events at one circuit on one date) and one candidate event was already
-- claimed by a different round via 0078's round_number match. This
-- migration explicitly excludes anything that isn't a clean 1:1 match on
-- BOTH sides (a round matching more than one event, or an event already
-- linked to a different round) rather than guessing — leaving those
-- handful null is far better than silently linking the wrong event. That
-- leaves 171 newly-linked rows (43 + 171 = 214 of 237 total).
with candidates as (
  select
    cr.subsession_id,
    e.id as event_id,
    count(*) over (partition by cr.subsession_id) as round_side_matches,
    count(*) over (partition by e.id) as event_side_matches
  from public.curated_rounds cr
  join public.circuits c on lower(c.name) = lower(cr.track_name)
  join public.events e
    on e.circuit_id = c.id
    and e.event_date = (cr.start_time at time zone 'America/New_York')::date
  where cr.event_id is null
    and not exists (select 1 from public.curated_rounds cr2 where cr2.event_id = e.id)
)
update public.curated_rounds cr
set event_id = candidates.event_id
from candidates
where cr.subsession_id = candidates.subsession_id
  and candidates.round_side_matches = 1
  and candidates.event_side_matches = 1;
