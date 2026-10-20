-- Alpha Touring Challenge — lap record as a number, not free text
--
-- Imported data gives the lap record as a plain count of seconds (down to
-- the nearest thousandth), not a pre-formatted "x:xx.xx" string — so the
-- column should store that raw number and the app formats it for display
-- (see formatLapTime() in src/lib/supabase.ts). Replaces the free-text
-- lap_record_time column added in 0010_circuit_layouts.sql; that column
-- only ever held a couple of admin-typed values at most, so this drops
-- rather than attempts to parse/migrate it.
alter table circuit_layouts drop column if exists lap_record_time;
alter table circuit_layouts add column if not exists lap_record_seconds numeric;
