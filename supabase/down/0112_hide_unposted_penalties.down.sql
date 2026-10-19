-- Undo 0112_hide_unposted_penalties.sql
-- Restores the old `using (true)` select policies (unposted penalties become
-- publicly readable again) and drops race_scores_public. Revert the app
-- change that reads race_scores_public in the same go, or public results and
-- standings pages will fail to load.

drop view if exists public.race_scores_public;

drop policy if exists "posted or admin read penalties" on public.penalties;
drop policy if exists "public read" on public.penalties;
create policy "public read" on public.penalties for select using (true);

drop policy if exists "posted or admin read penalty_offense_links" on public.penalty_offense_links;
drop policy if exists "public read" on public.penalty_offense_links;
create policy "public read" on public.penalty_offense_links for select using (true);

drop policy if exists "posted or admin read penalty_involved_drivers" on public.penalty_involved_drivers;
drop policy if exists "public read" on public.penalty_involved_drivers;
create policy "public read" on public.penalty_involved_drivers for select using (true);

drop policy if exists "posted or admin read round_penalties" on public.round_penalties;
drop policy if exists "public read round_penalties" on public.round_penalties;
create policy "public read round_penalties" on public.round_penalties for select using (true);

drop policy if exists "posted or admin read race_scores" on public.race_scores;
drop policy if exists "public read" on public.race_scores;
create policy "public read" on public.race_scores for select using (true);
