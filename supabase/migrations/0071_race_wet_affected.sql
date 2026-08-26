-- Alpha Touring Challenge — wet-affected flag per race
--
-- Per Logan: separate from the existing practice/qualifying/raceN_weather
-- columns (0050_weather_conditions_expanded.sql) — those are the FORECAST
-- an admin schedules a session with, entered ahead of the event; this is a
-- plain after-the-fact record of whether a given race actually ran wet
-- (rain during the race, track still drying, etc.), regardless of what was
-- forecast. Deliberately a simple boolean rather than reusing the Weather
-- enum — Logan just needs "was this race wet," not a second weather
-- classification to keep in sync with the first. Only races get this
-- column (not practice/qualifying) since that's the only thing Logan asked
-- to mark. Managed on the existing Admin -> Events form, one checkbox per
-- race alongside that race's own fields (see EventSessionFields.astro).
alter table public.events
  add column if not exists race1_wet_affected boolean not null default false,
  add column if not exists race2_wet_affected boolean not null default false,
  add column if not exists race3_wet_affected boolean not null default false;

comment on column public.events.race1_wet_affected is
  'Admin-marked after the fact: did Race 1 actually run in wet conditions? Independent of race1_weather (the pre-scheduled forecast).';
comment on column public.events.race2_wet_affected is
  'Same as race1_wet_affected, for Race 2.';
comment on column public.events.race3_wet_affected is
  'Same as race1_wet_affected, for Race 3.';
