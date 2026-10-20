# Data fixes

A data fix is a one-off correction to production **data** for a specific round or record, for
example linking an orphaned round to its season and event. It changes rows, never the schema.
Schema changes are migrations in `supabase/migrations/`.

Data fixes are kept out of `supabase/migrations/` because a fresh database (CI, a local
`supabase db reset`) must not replay corrections to rows that only exist in production.

## Writing one

- Name it `YYYYMMDD_description.sql`, dated the day it is written, in lowercase with underscores
  (for example `20261019_link_atc18_road_america_round_to_round_6.sql`). CI checks the name.
- It must be safe to re-run: guard each statement so a second run changes nothing (for example
  `where season_id is null`).
- Start it with a header comment that names the round (season, round number, circuit, date) and
  says what was wrong and why the fix is right.
- Add it through a pull request like any other change.

## Applying one

- Data fixes are applied **by hand**: the owner runs the file in the Supabase SQL editor, or
  Claude runs it through the Supabase connection with the owner's OK. CI never runs them.
- Then add a row to the log below with the file, the date it was applied and who applied it. Do
  it in the same pull request when the fix was applied before merge, otherwise in a follow-up.

## Legacy names

These four fixes predate the naming rule and keep their old names. They are exempt from it:

- `00891_delete_atc18_oulton_abandoned_race.sql`
- `00892_link_atc18_oulton_round_to_round_2.sql`
- `00911_atc18_r3_layout_and_delete_bad_oulton_round.sql`
- `0107_link_atc18_ctmp_round_to_round_5.sql`

## Log

| File | Applied | By |
|---|---|---|
| `00891_delete_atc18_oulton_abandoned_race.sql` | before 2026-10-19 | by hand |
| `00892_link_atc18_oulton_round_to_round_2.sql` | before 2026-10-19 | by hand |
| `00911_atc18_r3_layout_and_delete_bad_oulton_round.sql` | before 2026-10-19 | by hand |
| `0107_link_atc18_ctmp_round_to_round_5.sql` | before 2026-10-19 | by hand |
| `20261019_link_atc18_road_america_round_to_round_6.sql` | 2026-10-19 | owner |
