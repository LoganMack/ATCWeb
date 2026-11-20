-- Undoes 20261122120000_series_rating_history.sql: drops the Series iRating history view. Nothing else
-- changed; the stored rating steps stay.

drop view if exists public.series_rating_history_shown;
