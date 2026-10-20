-- Expand event weather conditions from dry/mixed/wet to a more granular
-- clear/partly_cloudy/overcast/raining/mixed set (Logan). Existing 'dry'
-- rows have no way to know after the fact whether that session was clear,
-- partly cloudy, or overcast, so they're best-effort remapped to 'clear'
-- (the most common case) — go back and hand-correct any specific
-- historical event from Admin > Events if a different value is more
-- accurate. 'wet' maps directly to 'raining' (its closest match, though no
-- rows currently use it); 'mixed' is unchanged either way.
--
-- Constraints are dropped BEFORE the data UPDATEs (not after) — the old
-- constraint only allows 'dry'/'mixed'/'wet', so an UPDATE ... SET
-- practice_weather = 'clear' would itself violate the still-active old
-- constraint if run first.

alter table events drop constraint if exists events_practice_weather_check;
alter table events drop constraint if exists events_qualifying_weather_check;
alter table events drop constraint if exists events_race1_weather_check;
alter table events drop constraint if exists events_race2_weather_check;
alter table events drop constraint if exists events_race3_weather_check;

update events set practice_weather = 'clear' where practice_weather = 'dry';
update events set practice_weather = 'raining' where practice_weather = 'wet';
update events set qualifying_weather = 'clear' where qualifying_weather = 'dry';
update events set qualifying_weather = 'raining' where qualifying_weather = 'wet';
update events set race1_weather = 'clear' where race1_weather = 'dry';
update events set race1_weather = 'raining' where race1_weather = 'wet';
update events set race2_weather = 'clear' where race2_weather = 'dry';
update events set race2_weather = 'raining' where race2_weather = 'wet';
update events set race3_weather = 'clear' where race3_weather = 'dry';
update events set race3_weather = 'raining' where race3_weather = 'wet';

alter table events add constraint events_practice_weather_check
  check (practice_weather in ('clear', 'partly_cloudy', 'overcast', 'raining', 'mixed'));
alter table events add constraint events_qualifying_weather_check
  check (qualifying_weather in ('clear', 'partly_cloudy', 'overcast', 'raining', 'mixed'));
alter table events add constraint events_race1_weather_check
  check (race1_weather in ('clear', 'partly_cloudy', 'overcast', 'raining', 'mixed'));
alter table events add constraint events_race2_weather_check
  check (race2_weather in ('clear', 'partly_cloudy', 'overcast', 'raining', 'mixed'));
alter table events add constraint events_race3_weather_check
  check (race3_weather in ('clear', 'partly_cloudy', 'overcast', 'raining', 'mixed'));
