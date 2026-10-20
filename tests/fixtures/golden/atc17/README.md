# Golden season: ATC17

The standings inputs for ATC17 and the standings the live site showed for it, captured once as the
oracle for `tests/golden/atc17.test.ts`. The pure standings path must reproduce `expected.json` from
`inputs.json` exactly.

**Never refresh or edit these files to make a test pass.** A mismatch is a finding: either the
capture missed an input, or a code change altered the standings. A new capture is a reviewed change
with its own pull request.

## Capture

- **Taken:** 2026-10-20 18:19:52 UTC.
- **Site serving:** `main` at `cb0838883fe7146afea24423026fcebb6ffd5036` ("Keep deploys moving when
  migrations merge out of order or fail (#92)"). The Deploy workflow run for that commit
  (run 39467958825) succeeded at 17:42:55 UTC, before the capture. This is before any standings code
  was extracted (PR 2 of the test-harness unit), so the capture is the pre-change oracle.
- **Command**, from the repository root:

  ```sh
  node scripts/capture-golden-season.mjs --season ATC17
  ```

- **Sources:** only public read paths. The Supabase REST API with the public anon key committed in
  `wrangler.jsonc` (the key the site ships, so penalties are the posted ones anon can see, exactly
  as on the live page), and the public page `/standings/fragment?season=17&championship=drivers`
  with `class=all`, `Alpha`, `Gamma` and `Delta`, `mode=list`. No other credential was used.
- **Season state:** ATC17 is finished. Its `is_current` is false, and its last round ran on
  2026-07-13. Results and standings are those posted on the public site at capture time.

## What is in the files

- `inputs.json`: the rows the standings code reads, with the same filters and columns as the live
  code (see the W3 table in the test-harness functional spec), plus `counts`. Every read was paged in
  1000-row pages with a unique order.
- `expected.json`: for the overall view and each class the page offers, every row's position,
  driver id and total, and the fragment URL it came from.

## Row counts

| Key | Rows |
|---|---|
| `rulesets` | 7 |
| `classes` | 3 |
| `drivers` | 423 |
| `excludedRoundIds` | 11 |
| `scoresByClass` | Alpha (1): 101, Gamma (2): 184, Delta (3): 223 |
| `overallScores` | 508 |
| `seasonRounds` | 13 |
| `rawResults` | 504 |
| `lapStats` | 504 |
| `penalties` | 56 |

Standings rows in `expected.json`: overall 62, Alpha 9, Gamma 16, Delta 37.

None of the `race_scores_public` reads came near 1000 rows, so the live page (which reads them
unpaged) was not truncated.

## Privacy

- **iRacing customer ids are pseudonymised.** Every `iracing_cust_id` / `cust_id` was replaced
  with a stand-in: 1, 2, 3, ... in driver-id order, and then any entrant with no driver row in order
  of first appearance (there were none). The same mapping is applied in `drivers`, `rawResults` and
  `lapStats`, so every join still works.
- **Driver names are kept**, because the standings page already shows them publicly and the name is
  the last tiebreaker.
- Drivers carry only `id`, `name` and the stand-in customer id. The other fields the code's driver
  shape has are fixed (`null` or `false`), because standings never read them. No bio, no
  `created_by`.
- Steward penalty descriptions (`penalties[].description`) are kept verbatim. They mention car
  numbers and other drivers, as the public site already shows them.
- The files were checked with `node supabase/tools/secret-scan.mjs` (clean) and read before commit.
