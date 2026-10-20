-- Corrects a bug in the immediately-preceding 0074_backfill_championship_
-- categories.sql: its Part 1 (UPDATE) nulled out subsession_id on every
-- event it converted to 'championship' before Part 2 (INSERT) ran its own
-- "does an event already exist for this subsession" guard. Since that guard
-- checked events.subsession_id, and Part 1 had already cleared it on
-- exactly the rows Part 2 needed to skip, every one of the 169 just-fixed
-- events got a second, redundant row inserted alongside it (169 pairs = 338
-- rows). The 19 genuinely-missing rounds 0074 also inserted (which had no
-- original row to collide with) were unaffected and are not touched here.
--
-- Fix: keep the older row (the original 0072-backfilled event, already
-- correctly updated by 0074's Part 1) and drop the newer duplicate 0074
-- accidentally introduced, per (season_id, round_number) group. Verified
-- before running: every affected group had exactly 2 rows (169 groups, 338
-- rows total) — no triples, nothing else to reconcile.
delete from public.events e
using (
  select id,
    row_number() over (partition by season_id, round_number order by created_at asc) as rn
  from public.events
  where category = 'championship' and event_date < '2026-01-12'
) dup
where e.id = dup.id and dup.rn > 1;
