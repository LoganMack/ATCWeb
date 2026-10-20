# Archived migrations

These are the site's numbered migrations from before the schema baseline (`0001_init.sql` to
`0116_security_fixes_followup.sql`). They are kept only as history. **Nothing in this folder is
ever run**, by CI, by `supabase db reset` or by hand. The Supabase CLI only reads files directly
in `supabase/migrations/`, so it never sees this folder.

## What replaced them

On 2026-10-20 production's schema was dumped after `0116` was applied and committed as two
migrations:

- `../20261020120000_baseline_schema.sql`: the `public` and `private` schemas (tables, views,
  functions, triggers, policies, grants);
- `../20261020120001_baseline_platform.sql`: what the site adds to Supabase's own schemas (the
  storage buckets and their policies, the `auth.users` sign-up trigger, default privileges).

A fresh database is built from those two files, then from any newer timestamped migration. The
files here describe how production got to that state, step by step; the baseline is what it is.

## Rules

- Files here are never edited, deleted or added to. CI (`supabase/tools/check-migrations.mjs`)
  fails any pull request that tries, except the one that created this folder.
- To change the schema, add a new timestamped migration in `supabase/migrations/` with its down
  script in `supabase/down/`.
- Round-specific data corrections are not migrations. The four that used to sit among these files
  (`00891`, `00892`, `00911`, `0107`) moved to `supabase/data-fixes/`.

## Oddities in the old numbering

- **Five-digit versions** (`00031`, `00041`, `00051`, `00721`–`00724`, `00891`, `00892`,
  `00911`, `00981`): files slotted in after an existing four-digit number without renumbering
  (`00891` and `00892` follow `0089`). Their order depends on how the names are sorted, which
  is one reason the numbering was replaced by timestamps.
- **Two files numbered `0103`** (`0103_circuit_logo_background.sql` and
  `0103_page_view_stats_performance.sql`): the same number was used twice. Both are applied in
  production; neither has a history row.
- **History gaps:** `0103` to `0111` were applied by hand in the SQL editor and never recorded in
  `supabase_migrations.schema_migrations`. `0112` to `0116` are recorded under timestamp versions
  (`20261019172641` to `20261019203443`) with the file name as the name.

## `history.csv`

Production's migration history (`version,name`, 118 rows) exported read-only on 2026-10-20,
just before the history cutover. The cutover copies the same rows into
`supabase_migrations.schema_migrations_legacy` and replaces them with the two baseline versions
(`supabase/tools/history-cutover.sql`).

## `repair-migration-history.sql`

A one-off script from 2026-10-08 that rewrote the history table to match the numbered files. It
is superseded by the history cutover and must not be run again.
