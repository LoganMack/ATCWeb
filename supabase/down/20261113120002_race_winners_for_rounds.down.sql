-- Undoes 20261113120002_race_winners_for_rounds.sql: drops public.race_winners_for_rounds.
--
-- No data changes. Revert the site code first, so the Race Results page stops calling the function (it
-- already renders rows without winners when the call fails).

drop function public.race_winners_for_rounds(bigint[]);
