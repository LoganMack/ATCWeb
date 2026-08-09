-- Alpha Touring Challenge — Hall of Fame membership
--
-- Same pattern as 0011_driver_signup_date.sql: a single manually-set flag on
-- `drivers`, toggled by an admin (see /admin/drivers/[id]), no separate join
-- table needed since membership is a simple yes/no per driver, not something
-- that varies per season. Powers the public /hall-of-fame page — see
-- src/lib/supabase.ts's getHallOfFameDrivers() and src/pages/hall-of-fame.astro.
alter table drivers add column if not exists is_hall_of_fame boolean not null default false;
