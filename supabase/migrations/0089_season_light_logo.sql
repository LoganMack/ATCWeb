-- Alpha Touring Challenge — per-season light-mode logo variant
--
-- The site gained a light/dark theme toggle. `seasons.logo_url` (0024) is
-- treated as the dark-mode logo from here on — every logo an admin has
-- already uploaded stays exactly where it is, no backfill needed. This adds
-- a second, optional `logo_url_light` column for a light-mode-specific
-- variant; when it's null (the default for every existing and future
-- season until an admin sets one), the site just keeps showing the dark
-- logo in light mode too, rather than showing nothing.
--
-- No RLS changes needed: 0024's "admin update seasons" policy is a
-- blanket per-row `using (is_admin())`, not scoped to specific columns, so
-- it already covers writes to this new column.

alter table seasons add column if not exists logo_url_light text;
