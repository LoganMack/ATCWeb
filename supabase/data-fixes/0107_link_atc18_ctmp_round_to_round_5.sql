-- ATC18 Round 5 (Canadian Tire Motorsports Park, 2026-10-12): the results pipeline
-- inserted the round (subsession 89326124, 47 drivers, endurance) with only the
-- free-text season_label, so it had no season, no calendar event, and no layout, and
-- race_scores was never written. A round with no season_id doesn't show under any
-- season on the Results page and can't be scored.
--
-- This does the same thing Admin > Events' Season + Event picker does for an orphaned
-- round (associateRound() in src/lib/orphanRounds.ts): link the round to ATC18 and to
-- its calendar event (events.id 2cd65756-6ccb-47c0-ac45-0b476f67b505, same circuit and
-- date, layout N/A), fill in the layout from that event, then score the round.
update curated_rounds
   set season_id = 'e2582051-2838-475d-bef9-3d6eb8e7f4e8',
       season_label = 'ATC18',
       event_id = '2cd65756-6ccb-47c0-ac45-0b476f67b505',
       layout = coalesce(layout, 'N/A')
 where subsession_id = 89326124
   and season_id is null
   and event_id is null;

select recalculate_race_scores(89326124);
