-- Alpha Touring Challenge — tie the roster to iRacing identity
--
-- Adds `iracing_cust_id` to the `drivers` roster so race results can be
-- attributed to a rostered driver: curated_race_results.cust_id =
-- drivers.iracing_cust_id (both bigint). This is the ATTRIBUTION anchor that
-- makes standings, driver-history pages, and penalty-point accrual to
-- drivers.penalty_points work for the WHOLE roster — not just drivers who
-- happen to have a website login. See HANDOFF.md "Races data model".
--
-- Relationship recap:
--   * drivers.iracing_cust_id  — admin-asserted "this roster driver races as
--     this iRacing id" (the workhorse for public attribution).
--   * profiles.iracing_cust_id — user-proven identity from iRacing OAuth (later);
--     matching the two is how you confidently link a login to a roster row.
-- Neither is a FK from curated_race_results: results contain every racer
-- (guests / non-members), so the join is a soft equality join.

alter table drivers add column iracing_cust_id bigint unique;

comment on column drivers.iracing_cust_id is
  'iRacing customer id this roster driver competes under. Soft join key to '
  'curated_race_results.cust_id (not a FK). Admin-populated. Hidden from the '
  'anon role (see grants below) but readable by authenticated users.';

-- ---------------------------------------------------------------------------
-- Keep iracing_cust_id off the PUBLIC (anon) roster endpoint
-- ---------------------------------------------------------------------------
-- `drivers` is public-read (0001 "public read" RLS). Postgres can't revoke a
-- single column from a role that holds table-level SELECT, so we drop anon's
-- table-level SELECT and re-grant every column EXCEPT iracing_cust_id.
--
-- `authenticated` is intentionally left with full SELECT: admins edit this
-- field through the normal authenticated client, and Supabase has no separate
-- admin DB role to column-gate against (admin-ness is RLS-level via is_admin()).
-- Per the chosen tradeoff, logged-in users may therefore read cust_ids;
-- iRacing ids are low-sensitivity (they appear in public iRacing URLs).
--
-- FOOTGUN: because anon no longer has a table-level grant here, any NEW column
-- added to `drivers` later will be hidden from anon until you add it to this
-- grant list. That's fail-safe (a new column can't leak by accident), but
-- remember to extend the grant when a new column should be public.

revoke select on public.drivers from anon;

grant select (
  id, car_number, name, status_id, class_id, team_id, is_rookie, car,
  appearances, starts, seasons_count, penalty_points, penalty_points_max,
  photo_url, bio, created_at, updated_at
) on public.drivers to anon;
