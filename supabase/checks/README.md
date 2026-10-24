# Database checks

SQL files that check the database's behaviour. None of them changes data that outlives the run.

| File | Runs against | When | What it checks |
|---|---|---|---|
| `scoring-fixtures.sql` | the empty database CI rebuilds from `supabase/migrations/` | every PR that changes `supabase/` (job `migrations-rebuild` in `.github/workflows/migrations-pr.yml`) | `score_round`, `score_round_preview`, the scoring triggers, the `race_score_results` write guard, locked seasons, the kill switch and `race_score_results_public`; the functions the contract migration rewrote (`submit_kudos`, `sync_results_with_roster`, `recalculate_season_scores`); and the retired TypeScript engine's penalty cases (C44-C51), on small rounds built inside the file |
| `round-stats-fixtures.sql` | the same rebuilt database, after `scoring-fixtures.sql` | the same CI job | the round stats tables (`round_driver_stats`, `round_team_stats`, `round_penalty_points`): per-driver and team numbers, concealment (also in an admin session, after a failed refresh and on an unposting with the kill switch off), read access, the write guard, the kill switch, failures recorded as issues, `rebuild_season_stats`, one deferred refresh per round per transaction, the freshness status `round_stats_status` (current, kill switch off, refresh issue, stats older than scores, posting disagreement, anon access), and a report of the refresh's added time at real-round size, run last (C52-C76) |
| `driver-linking-fixtures.sql` | the same rebuilt database, after `round-stats-fixtures.sql` | the same CI job | self-linking (`link_my_driver`, `list_unlinked_drivers`, `my_link_state`) and the profiles guard, the one-account-per-driver index, website driver requests (`submit_driver_request`, its error codes and daily limit), approving and rejecting website requests, the Discord bot's rejection feed, account deletion with open requests, and the grants on the self-service functions (L01-L22) |
| `account-settings-fixtures.sql` | the same rebuilt database, after `driver-linking-fixtures.sql` | the same CI job | the owner-only `account_settings` table (Row Level Security, column grants, admin reads, cascade on profile delete), the per-account email limit `claim_email_action` and its grants, and the avatar delete policy (A01-A12) |
| `driver-privacy-fixtures.sql` | the same rebuilt database, after `account-settings-fixtures.sql` | the same CI job | the masked `*_shown` views and their helpers (U4): owner rights, security barrier and select-only grants; what anon, an account with no driver, a linked driver and an admin read from every view; the base policies' row filters; prose and mention masking; the query plans; and the catalog-driven leak check with its negative control (P01-P18) |
| `driver-privacy-timing.sql` | production, read-only | by hand, before the driver privacy expand step merges | the database time the masked views add to the round results, news list and penalties reads (medians of 10 runs as anon) |
| `scoring.sql` | production, read-only | after the scoring migration is applied or a backfill runs, with the owner's OK | the live invariants: stored scores are fresh, positions are consistent, totals match their formulas, unposted rounds are concealed from anon, every scored round has rows or an open issue |
| `security-fixes.sql` | production, read-only | after each security-fix rollout step | the security fixes from migrations 0114–0116 (every row reads PASS) |

## Two conventions

**Fixtures raise.** In `scoring-fixtures.sql` every assertion calls `scoring_fixture.expect(label, actual, expected)`, which raises an exception naming the case when the two differ. Run with `psql -v ON_ERROR_STOP=1`, the first failure stops the run with a non-zero exit, which fails the CI step. A passing run prints one `ok Cnn …` notice per case.

The whole file is one transaction that ends in `rollback`. The base data is inserted once; each case starts after `savepoint fixture` and ends with `rollback to savepoint fixture`, so cases are independent and nothing is left in the database. The helper functions live in a `scoring_fixture` schema that is created inside that transaction and rolled back with it.

The penalty cases (C44 onwards) stage their entrants and penalties in `values` blocks (`scoring_fixture.entrant`, `scoring_fixture.penalty`), call `scoring_fixture.load(season_id, format)` to create the drivers (one per letter code), rounds, results and penalties, and read rows back by letter code with `scoring_fixture.by_code`.

To add a case: write the setup statements, then a `do $$ … $$` block that calls `scoring_fixture.expect` (use `scoring_fixture.col(subsession_id, 'r.<column>')` for a compact `cust=value` list of a round's stored rows, or `scoring_fixture.preview_col` for `score_round_preview` with switches), end it with `raise notice 'ok Cnn …'`, and finish with `rollback to savepoint fixture;`.

**Live checks return violating rows.** `scoring.sql` (and `security-fixes.sql`) only read. Each query in `scoring.sql` returns the rows that break an invariant, with the check's name in the first column, so an all-empty result means everything holds. The concealment query switches to the `anon` role inside a transaction that is rolled back.

## Running them

The fixtures, locally, against a database rebuilt the same way CI does it (Docker and `npm ci` needed):

```bash
npx supabase start -x realtime,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
npx supabase db reset
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -X -q -v ON_ERROR_STOP=1 -f supabase/checks/scoring-fixtures.sql
```

The live checks, with the owner's OK, either pasted into the Supabase SQL editor or with psql (the connection URL stays in your shell, never in the repo):

```bash
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/checks/scoring.sql
```

The recompute query calls `score_round_preview` once per round, so it takes a few seconds on production's data.
