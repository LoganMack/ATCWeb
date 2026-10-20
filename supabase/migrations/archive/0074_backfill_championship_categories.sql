-- Fixes every real championship round before 2026-01-12 that 0072_backfill_
-- events_from_rounds.sql mis-marked (or entirely failed to create) as
-- 'exhibition'. Per Logan: "every championship round prior to January 12th,
-- 2026 is incorrectly marked as an exhibition."
--
-- Root causes, both inside 0072's one-time backfill script, neither a schema
-- problem:
--
--   1. round_number gap. 0072 only classified a round 'championship' when
--      curated_rounds.round_number was already set. That column was never
--      populated for seasons ATC1-ATC15 (0 of ~13/season have one) or for
--      ATC16's first four rounds — round numbering only started being
--      entered going forward from partway through ATC16. Every one of those
--      rounds fell through to 'exhibition' with season_id/round_number
--      nulled out, even though they're ordinary championship rounds.
--      Recomputed here the same way the site already numbers rounds when it
--      DOES have the data: chronological order within the season, skipping
--      any round flagged is_test or is_exhibition in round_overrides (this
--      exactly reproduces every round_number ATC16 already had on file
--      before this migration — verified row for row — so it's the same
--      rule the admins have been using by hand, not a new one).
--
--   2. Same-day dedup collision. 0072 skipped inserting a round's `events`
--      row if ANY event already existed at that circuit+date — including an
--      unrelated round_overrides.is_test session run hours earlier at the
--      same track on the same calendar day (three cases: ATC2/Daytona
--      2021-07-12, ATC7/Road Atlanta 2023-05-01, ATC16/Road Atlanta
--      2026-01-05). The test session's own event claimed the slot; the real
--      round's event was never created at all.
--
--   3. [Retired]-tag circuit misses. 0072 matched curated_rounds.track_name
--      to circuits.name by exact normalized string, with no allowance for
--      iRacing's "[Retired] X" prefix on a track's older, superseded
--      configuration (see the "[Retired]" handling results.ts's
--      normalizeTrackOrLayoutName() already carries, and its comment
--      confirming no "[Retired]"-tagged name has ever been given its own
--      circuits row — same rule reused here). 16 rounds at Watkins Glen,
--      WeatherTech Raceway at Laguna Seca, Charlotte Motor Speedway, and
--      Barber Motorsports Park hit "no circuit on file" under the old exact
--      match and were silently skipped — never inserted as an event at all.
--
-- Net effect being corrected: 169 existing 'exhibition' events flip to
-- 'championship' (season_id + round_number filled in, subsession_id
-- cleared — championship events resolve their round via season+round, not
-- a pinned subsession, same convention 0072 itself used); 19 championship
-- rounds that had NO events row at all get one inserted now, built the same
-- way 0072 would have (circuit_id via the corrected match, layout copied
-- verbatim from curated_rounds, format defaulting to 'sprint').
--
-- Scoped to event_date < '2026-01-12' throughout, matching what Logan
-- flagged — rounds on/after that date were already correct.

-- Part 1: flip existing mis-marked 'exhibition' events to 'championship'.
with flagged as (
  select subsession_id,
    coalesce(is_exhibition, false) as is_exhibition,
    coalesce(is_test, false) as is_test
  from public.round_overrides
),
championship_rounds as (
  select
    cr.subsession_id,
    cr.season_id,
    row_number() over (partition by cr.season_id order by cr.start_time asc) as computed_round_number
  from public.curated_rounds cr
  join public.seasons s on s.id = cr.season_id
  left join flagged f on f.subsession_id = cr.subsession_id
  where trim(s.name) ~* '^ATC[0-9]+$'
    and coalesce(f.is_exhibition, false) = false
    and coalesce(f.is_test, false) = false
)
update public.events e
set
  category = 'championship',
  season_id = cro.season_id,
  round_number = cro.computed_round_number,
  subsession_id = null
from championship_rounds cro
where e.subsession_id = cro.subsession_id
  and e.category = 'exhibition'
  and e.event_date < '2026-01-12';

-- Part 2: insert the championship rounds that never got an events row.
with flagged as (
  select subsession_id,
    coalesce(is_exhibition, false) as is_exhibition,
    coalesce(is_test, false) as is_test
  from public.round_overrides
),
championship_rounds as (
  select
    cr.subsession_id,
    cr.season_id,
    cr.start_time,
    cr.track_name,
    cr.layout,
    cr.format,
    row_number() over (partition by cr.season_id order by cr.start_time asc) as computed_round_number
  from public.curated_rounds cr
  join public.seasons s on s.id = cr.season_id
  left join flagged f on f.subsession_id = cr.subsession_id
  where trim(s.name) ~* '^ATC[0-9]+$'
    and coalesce(f.is_exhibition, false) = false
    and coalesce(f.is_test, false) = false
)
insert into public.events (circuit_id, layout, event_date, format, category, season_id, round_number, subsession_id)
select
  (
    select c.id
    from public.circuits c
    where regexp_replace(lower(c.name), '[^a-z0-9]', '', 'g')
        = regexp_replace(lower(regexp_replace(cro.track_name, '^\[retired\]\s*', '', 'i')), '[^a-z0-9]', '', 'g')
    limit 1
  ) as circuit_id,
  cro.layout,
  (cro.start_time at time zone 'America/New_York')::date as event_date,
  coalesce(cro.format, 'sprint') as format,
  'championship' as category,
  cro.season_id,
  cro.computed_round_number,
  null as subsession_id
from championship_rounds cro
where cro.start_time < '2026-01-12'
  and not exists (select 1 from public.events e where e.subsession_id = cro.subsession_id);
