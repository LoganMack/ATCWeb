-- history-cutover.sql: a one-off tool script, NOT a migration. Run it once against production,
-- only with the owner's OK, as a single request through the Supabase connection (or pasted
-- whole into the SQL editor). Undo: supabase/tools/history-cutover.down.sql.
--
-- What: moves production's 118 old migration-history rows into
-- supabase_migrations.schema_migrations_legacy and replaces them with the two baseline
-- versions, 20261020120000_baseline_schema and 20261020120001_baseline_platform.
--
-- Why: after the baseline PR, supabase/migrations/ holds only the baseline (the old files are in
-- supabase/migrations/archive/). `supabase db push` refuses to run while the history lists
-- versions that have no file, and would try to re-apply the baseline if its versions were
-- missing. It touches only the history table: no schema or site data changes. The old rows are
-- kept in the legacy table and in supabase/migrations/archive/history.csv.
--
-- Safety: everything runs in one transaction. Each `do` block raises an exception when a count
-- is wrong, which aborts the whole transaction and leaves the history as it was. Creating the
-- legacy table fails if it already exists, so a second run changes nothing.

begin;

-- Copy every column of the history table (whatever this CLI version created), plus the time of
-- the copy.
create table supabase_migrations.schema_migrations_legacy as
  select m.*, now()::timestamptz as archived_at
  from supabase_migrations.schema_migrations m;

alter table supabase_migrations.schema_migrations_legacy
  alter column archived_at set default now(),
  alter column archived_at set not null;

do $$
declare
  legacy_count integer;
  source_count integer;
begin
  select count(*) into legacy_count from supabase_migrations.schema_migrations_legacy;
  select count(*) into source_count from supabase_migrations.schema_migrations;
  if legacy_count <> 118 or source_count <> 118 then
    raise exception 'history cutover aborted: expected 118 rows, found % in schema_migrations and % in the legacy copy',
      source_count, legacy_count;
  end if;
end
$$;

delete from supabase_migrations.schema_migrations;

insert into supabase_migrations.schema_migrations (version, name, statements) values
  ('20261020120000', 'baseline_schema', array[]::text[]),
  ('20261020120001', 'baseline_platform', array[]::text[]);

do $$
declare
  live_count integer;
  baseline_count integer;
begin
  select count(*) into live_count from supabase_migrations.schema_migrations;
  select count(*) into baseline_count from supabase_migrations.schema_migrations
    where version in ('20261020120000', '20261020120001');
  if live_count <> 2 or baseline_count <> 2 then
    raise exception 'history cutover aborted: expected exactly the 2 baseline rows, found % rows (% baseline)',
      live_count, baseline_count;
  end if;
end
$$;

commit;
