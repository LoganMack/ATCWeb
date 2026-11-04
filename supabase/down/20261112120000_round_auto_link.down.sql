-- Undo 20261112120000_round_auto_link.sql: new rounds stop being linked to their events on insert.
-- Rounds already linked stay linked.

drop trigger curated_rounds_auto_link on public.curated_rounds;
drop function private.curated_rounds_auto_link();
drop function public.round_event_matches(bigint[]);
