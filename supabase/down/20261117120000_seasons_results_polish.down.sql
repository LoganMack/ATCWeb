-- Undoes 20261117120000_seasons_results_polish.sql: drops public.season_race_summaries, the "admin insert
-- seasons" policy and the events practice_wet_affected and qualifying_wet_affected columns.
--
-- Dropping the columns loses every Practice and Qualifying wet flag admins set. Seasons already created stay.
-- Revert the site code first, so nothing reads the columns or calls the function in between.

drop function public.season_race_summaries(bigint[]);

drop policy "admin insert seasons" on public.seasons;

alter table public.events
  drop column qualifying_wet_affected,
  drop column practice_wet_affected;
