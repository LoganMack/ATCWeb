-- Alpha Touring Challenge — remove the dead penalties_old table
--
-- penalties_old was superseded by the current penalties / penalty_offenses /
-- penalty_offense_links / penalty_involved_drivers schema a while back — it
-- had 0 rows and no app code (this repo) ever reads or writes it (confirmed
-- via a full grep audit). The only thing still pointing at it was the
-- `stale_rounds` view (a "which rounds need rescoring" freshness check),
-- which is also unused by this app and was already semantically stale
-- itself: it joined against penalties_old's OLD column shape
-- (subsession_id/race_number/cust_id/applied/dsq), not the current
-- `penalties` table's shape (driver_id, no `applied` staging flag, no
-- `dsq` column). Dropping both together rather than leaving stale_rounds
-- dangling on a table that no longer exists.
--
-- Note found while auditing this: recalculate_race_scores() (a DB function,
-- not part of this repo) ALSO still references `public.penalties` using
-- that same old column shape (p.cust_id / p.applied / p.dsq) — none of
-- which exist on the current `penalties` table. That function was not
-- touched here (out of scope for this cleanup, and rewriting the scoring
-- engine is a bigger, separate decision) but it is very likely broken
-- against the current schema; flagged to Logan separately.

drop view if exists public.stale_rounds;
drop table if exists public.penalties_old;
