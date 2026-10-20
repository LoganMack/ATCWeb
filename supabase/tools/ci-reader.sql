-- ci-reader.sql (a tool script, not a migration: run it once, by hand, in the Supabase SQL editor)
--
-- Creates `ci_reader`, the read-only login the `migrations-dry-run` CI job uses through the
-- repository secret CI_READONLY_DB_URL. It can read the migration history table and nothing else,
-- so a leaked URL exposes only which migrations have run.
--
-- BEFORE RUNNING: replace <REPLACE_ME> with a long random password, in the SQL editor only.
-- Never commit the real password; this file keeps the placeholder.
--
-- The CI secret then uses Supabase's session-pooler form (GitHub runners are IPv4-only):
--   postgresql://ci_reader.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
--
-- Undo: drop role ci_reader;

create role ci_reader with login password '<REPLACE_ME>'
  nosuperuser nocreatedb nocreaterole noinherit noreplication;

-- Belt and braces: even a grant added by mistake later could not be used to write.
alter role ci_reader set default_transaction_read_only = on;

grant usage on schema supabase_migrations to ci_reader;
grant select on supabase_migrations.schema_migrations to ci_reader;
