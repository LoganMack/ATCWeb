-- Mirrors round_overrides.is_exhibition (0005_round_overrides.sql) with a
-- second, independent flag for a "test" round — a private/practice session
-- an admin manually imported results for, distinct from a for-fun
-- non-points EXHIBITION round. Both flags live on the same row/table since
-- they're the same kind of thing (an admin-set override on one specific
-- round, upserted on subsession_id) and are NOT mutually exclusive columns
-- squeezed into one enum — a round could in principle be flagged both ways
-- during cleanup, and keeping them as two booleans means a bad flip of one
-- never silently clobbers the other the way switching a single "category"
-- column would.
--
-- Per Logan: TEST/EXHIBITION event categories (0035_events_rounds_categories.sql)
-- are season-agnostic, so a round tied to one of those events won't
-- generally carry a season_id the way a championship round does — this
-- flag is what /results (the results LIST page) filters on to show/hide
-- test rounds, the same way it already can for exhibition rounds via
-- is_exhibition, independent of whichever season (if any) the round
-- happens to be under.
alter table public.round_overrides
  add column is_test boolean not null default false;
