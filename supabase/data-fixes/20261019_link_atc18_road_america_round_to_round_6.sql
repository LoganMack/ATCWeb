-- ATC18 Round 6 (Road America, 2026-10-19): same problem 0107 fixed for Round 5.
-- The results pipeline inserted the round (subsession 89494354, 41 drivers) with only the
-- free-text season_label, so it has no season, no calendar event, and no layout, and
-- race_scores was never written. A round with no season_id doesn't show under any
-- season on the Results page (or the Latest Results link) and can't be scored.
--
-- This does what Admin > Events' Season + Event picker does for an orphaned round
-- (associateRound() in src/lib/orphanRounds.ts): link the round to ATC18 and to its
-- calendar event (events.id 336c172e-4f3a-4f2a-8b1e-2b0ec9469697, Road America, 2026-10-19,
-- Full Course), fill in the layout from that event, then score the round.
-- Safe to re-run: it only touches the round while it is still unlinked.
update curated_rounds
   set season_id = 'e2582051-2838-475d-bef9-3d6eb8e7f4e8',
       season_label = 'ATC18',
       event_id = '336c172e-4f3a-4f2a-8b1e-2b0ec9469697',
       layout = coalesce(layout, 'Full Course')
 where subsession_id = 89494354
   and season_id is null
   and event_id is null;

select recalculate_race_scores(89494354);
