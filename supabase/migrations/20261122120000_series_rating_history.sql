-- Series iRating history: one driver's whole rated career, for the chart a Series iRating list row opens.
--
-- Why: the list (public.series_ratings_shown, migration 20261121120000) sends only the last 20 ratings
-- per driver to keep each page small on the Free plan. Expanding a row now draws the driver's entire
-- career, so this view exposes every stored rating step, read one driver at a time, only on demand.
--
-- What: public.series_rating_history_shown, one row per driver, kind and rated race: race start time,
-- subsession, race number, how many races the round had (to decide whether the race number is worth
-- showing), season number and name, track, the position used, field size and the rating after the race
-- (rounded). The driver is named only by the same key as the list: a hidden driver's stand-in, never a
-- driver id or name (NFR4, FR7.3). It runs as its owner, like the list view, because the steps table is
-- closed to every API role.
--
-- Expand-only: a new view and its grants; nothing that exists changes. Undo:
-- supabase/down/20261122120000_series_rating_history.down.sql.

create view public.series_rating_history_shown with (security_invoker = false, security_barrier = true) as
select
  st.kind,
  case when d.is_hidden then 'h' || abs(private.hidden_cust_id(d.id))::text else d.id::text end as driver_key,
  st.race_started_at,
  st.subsession_id,
  st.race_number,
  (select max(r.race_number) from public.race_score_results r where r.subsession_id = st.subsession_id)
    as round_races,
  s.number as season_number,
  s.name as season_name,
  cr.track_name,
  st.position,
  st.field_size,
  round(st.rating_after::numeric)::integer as rating_after
from private.rating_steps st
join public.drivers_shown d on d.id = st.driver_id
left join public.seasons s on s.id = st.season_id
left join public.curated_rounds cr on cr.subsession_id = st.subsession_id;

comment on view public.series_rating_history_shown is
  'Series iRating history (FR7): one row per driver, kind and rated race, rounded; keyed like series_ratings_shown, hidden drivers masked.';

revoke all on table public.series_rating_history_shown from public, anon, authenticated, service_role;
grant select on table public.series_rating_history_shown to anon, authenticated, service_role;
