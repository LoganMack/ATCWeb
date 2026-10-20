-- history-cutover.down.sql: undoes supabase/tools/history-cutover.sql. A one-off tool script,
-- NOT a migration (it has no matching migration, so it lives here rather than in
-- supabase/down/). Run it only with the owner's OK, as a single request through the Supabase
-- connection or pasted whole into the SQL editor.
--
-- What: puts the 118 old rows from supabase_migrations.schema_migrations_legacy back into
-- supabase_migrations.schema_migrations, removes the two baseline rows and drops the legacy
-- table. It touches only the history table.
--
-- Safety: one transaction. It refuses to run when anything other than the two baseline rows is
-- in the history (a migration applied after the cutover would otherwise be lost) or when the
-- legacy table does not hold exactly 118 rows. Any failed check aborts the whole transaction.

begin;

do $$
declare
  live_count integer;
  baseline_count integer;
  legacy_count integer;
begin
  select count(*) into live_count from supabase_migrations.schema_migrations;
  select count(*) into baseline_count from supabase_migrations.schema_migrations
    where version in ('20261020120000', '20261020120001');
  select count(*) into legacy_count from supabase_migrations.schema_migrations_legacy;
  if live_count <> 2 or baseline_count <> 2 then
    raise exception 'undo aborted: the history holds % rows (% baseline); expected only the 2 baseline rows',
      live_count, baseline_count;
  end if;
  if legacy_count <> 118 then
    raise exception 'undo aborted: expected 118 rows in schema_migrations_legacy, found %', legacy_count;
  end if;
end
$$;

delete from supabase_migrations.schema_migrations
  where version in ('20261020120000', '20261020120001');

-- The legacy table is the history table's columns followed by archived_at, so once archived_at
-- is dropped its rows fit the history table column for column.
alter table supabase_migrations.schema_migrations_legacy drop column archived_at;

insert into supabase_migrations.schema_migrations
  select * from supabase_migrations.schema_migrations_legacy;

do $$
declare
  live_count integer;
begin
  select count(*) into live_count from supabase_migrations.schema_migrations;
  if live_count <> 118 then
    raise exception 'undo aborted: expected 118 rows restored, found %', live_count;
  end if;
end
$$;

drop table supabase_migrations.schema_migrations_legacy;

commit;
