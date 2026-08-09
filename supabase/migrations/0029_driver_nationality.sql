-- Alpha Touring Challenge — driver nationality flags
--
-- Up to 2 ISO 3166-1 alpha-2 country codes per driver (lowercase, e.g. 'us',
-- 'gb') — a driver can hold dual nationality and both are shown (see
-- src/components/DriverFlag.astro, which renders one flag when only
-- nationality_1 is set, or a split flag — left half nationality_1, right
-- half nationality_2 — when both are set). `drivers` already has admin
-- write/update policies from 0002_auth_admin.sql, so no RLS changes needed
-- here, just the two columns.

alter table drivers add column if not exists nationality_1 text;
alter table drivers add column if not exists nationality_2 text;
