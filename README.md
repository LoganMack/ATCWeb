# Alpha Touring Challenge — Website

The official website for the **Alpha Touring Challenge (ATC)**, an iRacing league. It publishes the roster, calendar, race results, standings, incident reports and league history, and includes an admin portal for running the league.

Built with [Astro](https://astro.build), [Tailwind CSS](https://tailwindcss.com) and [Supabase](https://supabase.com), and deployed to [Cloudflare Workers](https://workers.cloudflare.com).

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [Database](#database)
- [Authentication and admin access](#authentication-and-admin-access)
- [Results, scoring and penalties](#results-scoring-and-penalties)
- [Deployment](#deployment)
- [Maintenance tasks](#maintenance-tasks)
- [Conventions](#conventions)
- [Further reading](#further-reading)

## Features

### Public site

| Area                            | What it provides                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Home                            | Next event, latest news and league links                                                                            |
| News                            | Articles, including auto-generated race recaps                                                                      |
| Roster and driver profiles      | Teams, drivers, per-driver career pages                                                                             |
| Calendar                        | Upcoming and past events with local-time display and add-to-calendar                                                |
| Race results                    | Race, qualifying and practice results with penalties, best laps and expandable rows                                 |
| Incident reports                | Per-race incident list with a detail view and appeal submission                                                     |
| Standings                       | List, Matrix and Graph views; Season, Championship and Class filters; a "Standings by Round" slider; team standings |
| Champions, Awards, Hall of Fame | League history and honours                                                                                          |
| Driver and team stats           | Career and season statistics                                                                                        |
| Circuits and media              | Circuit records and layouts, photo galleries                                                                        |

### Admin portal

Everything is managed in the browser under `/admin`: seasons, events, rulesets, results imports, penalties and penalty offenses, incident reporting and appeals, drivers, teams, organizations, circuits, car logos, news, awards, champions, page banners, site properties, users, and an activity log. Admin pages are only available to signed-in users with the `admin` role.

## Architecture

- **Hybrid rendering.** Astro runs with `output: 'hybrid'` on the Cloudflare adapter. Most data-driven pages set `export const prerender = false` and render at the edge on each request.
- **Edge caching.** Public pages send `Cache-Control: public, s-maxage=…` and are cached at Cloudflare, so data edited in Supabase appears within about a minute without a redeploy. `src/middleware.ts` never caches responses for signed-in users, admins or broadcasters.
- **Shell then fragment.** Data-heavy pages (home, news, calendar, teams, media, results, standings, roster, incident reports and more) are split in two: `page.astro` is a fast shell that paints the heading and a pulsing skeleton, and `page/fragment.astro` does the data work and is fetched client-side into the shell. Scripts that act on fragment content must live in the shell, because `<script>` tags inside fetched HTML never run; forms inside a fragment POST to the fragment and redirect back to the shell.
- **No Supabase SDK.** `src/lib/supabase.ts` talks to PostgREST, GoTrue and Storage with plain `fetch`, which keeps the Worker bundle small and CPU time low.
- **Security lives in the database.** Row Level Security policies and `SECURITY DEFINER` functions are the access boundary. The anon key shipped to the browser is public by design and grants nothing the policies do not allow.
- **Small client scripts.** Interactivity (sortable tables, expandable rows, lightbox, CSV export, theme toggle) is plain TypeScript in `src/scripts`, with no UI framework.

## Getting started

### Prerequisites

- Node.js 22 or newer (`engines` in `package.json`)
- A Supabase project (the free tier is enough)
- Python 3 (only for regenerating roster seed data)
- A Cloudflare account (only for deploying)

### Setup

```bash
git clone <repository-url>
cd ATCWeb
npm install
cp .env.example .env
npm run dev
```

The dev server runs at `http://localhost:4321`.

Before the site shows data, set up the database:

1. Apply the migrations in `supabase/migrations/`, in file-name order: the two baseline files first, then any newer timestamped ones. With the Supabase CLI and Docker, `npx supabase start` and then `npx supabase db reset` does this for a local database.
2. Run the seed files in `supabase/seed/` (`seed_teams.sql`, `seed_drivers.sql`, `seed_news.sql`).

See [Database](#database) for how migrations work.

### Scripts

| Command                 | Purpose                                                |
| ----------------------- | ------------------------------------------------------ |
| `npm run dev`           | Start the local development server                     |
| `npm run build`         | Production build into `dist/`                          |
| `npm run preview`       | Preview the production build locally                   |
| `npm run deploy`        | Build and deploy with Wrangler                         |
| `npm run generate-seed` | Regenerate roster seed SQL from the roster spreadsheet |
| `npx astro check`       | Type-check `.astro` and `.ts` files                    |

## Configuration

The site reads four runtime variables. All are public values and are safe to commit.

| Variable                   | Purpose                               |
| -------------------------- | ------------------------------------- |
| `PUBLIC_SUPABASE_URL`      | Supabase project URL                  |
| `PUBLIC_SUPABASE_ANON_KEY` | Supabase anon (public) key            |
| `PUBLIC_DISCORD_URL`       | Discord invite link shown in the menu |
| `PUBLIC_REDBUBBLE_URL`     | Merchandise link shown in the menu    |

Locally they come from `.env`. In production they come from the `vars` block in `wrangler.jsonc`.

**Never commit a Supabase service role key.** The site does not need one.

Operational settings, such as the incident reporting window and the incident appeal window, are edited by admins in the browser under **Admin → Site Properties**, not in code.

## Project structure

```
src/
  components/     Reusable Astro components (results tables, cards, dialogs)
  layouts/        Public and admin page layouts
  lib/            Data access and business logic (see below)
  pages/          Routes; pages/admin holds the admin portal
  scripts/        Small client-side scripts
  styles/         Global styles, fonts and theme tokens
  middleware.ts   Edge caching and request handling
supabase/
  migrations/     Baseline + timestamped migrations (applied by CI on merge); archive/ holds the old ones
  down/           Undo script for each migration
  data-fixes/     One-off data corrections, applied by hand and logged
  tools/          Migration checks, schema dump/compare and one-off scripts
  seed/           Seed data and the roster seed generator
docs/             Project documentation and history
public/           Static assets and CSV import templates
wrangler.jsonc    Cloudflare Workers configuration
```

Key modules in `src/lib`:

| Module                                                          | Responsibility                                         |
| --------------------------------------------------------------- | ------------------------------------------------------ |
| `supabase.ts`                                                   | Fetch-based Supabase client and environment resolution |
| `auth.ts`                                                       | Sessions, roles and display names                      |
| `results.ts`                                                    | Results, standings and season context                  |
| `penalties.ts`, `penaltyActions.ts`                             | Penalty engine and admin actions                       |
| `incidents.ts`, `incidentReports.ts`, `incidentAppeals.ts`      | Incident reporting, posting and appeals                |
| `raceResultsImport.ts`, `importTemplates.ts`, `orphanRounds.ts` | Results import and orphaned-round handling             |
| `newsRecap.ts`                                                  | Automatic race recap articles                          |
| `siteSettings.ts`, `pageBanners.ts`, `activityLog.ts`           | Site configuration and auditing                        |

## Database

**Migrations.**

- `supabase/migrations/` starts from a two-part baseline: production's full schema as of 2026-10-20.
- New changes are timestamped files, `YYYYMMDDHHMMSS_description.sql`, each with a header comment saying what it does and why.
- Every migration ships with an undo script, `supabase/down/<same name>.down.sql`, in the same pull request.
- Never edit or delete a migration once it has been applied. Undo it with a new migration whose body is its down script.
- **Expand, then contract.** A migration applies while the old code is still serving traffic, so it must keep the code currently on `main` working. Add columns, tables or functions first, switch the code over in a later PR, and only then remove what the old code needed.
- **If a deploy stops at the apply step,** the run's log names the failing migration, and production keeps its previous schema and code. Fix it in a new PR. A migration that never applied may be corrected in place: `migrations-static` reads production's history (read-only) and allows the edit only when that version never ran. Pull your branch up to date with `main` before merging a migration; out-of-order timestamps still apply (`--include-all`), but merging in order keeps the history easy to read.
- The pre-baseline files live in `supabase/migrations/archive/`; they are never run again.

**How migrations reach production.** The `deploy.yml` workflow runs on every merge to `main`, in this order, and stops at the first failure:

1. The build and test gates.
2. A drift check that production still matches the migrations.
3. `supabase db push`, which applies anything pending.
4. `wrangler deploy`.
5. A smoke check of the live site.

**Pull-request checks.** `migrations-pr.yml` runs on every pull request:

- `migrations-static` checks names, down scripts and the archive.
- `migrations-rebuild` rebuilds a throwaway database from the migrations and exercises each new down script.
- `migrations-dry-run` lists what would be applied to production.

Pull requests from forks never see production credentials.

**Data fixes.** Corrections to specific rounds' data go in `supabase/data-fixes/`, never in `migrations/`. They are applied by hand (or by Claude with the owner's OK) and logged in `supabase/data-fixes/README.md`. CI never runs them.

**Credentials.** These live only in GitHub, never in the repo:

- `CI_READONLY_DB_URL`, a repository secret: role `ci_reader`, which can read only the migration history.
- `PRODUCTION_DB_URL`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, in the `production` environment, limited to `main`.

Database URLs use Supabase's session-pooler form, because GitHub runners are IPv4-only: `postgresql://<role>.<project-ref>:<password>@aws-1-us-west-2.pooler.supabase.com:5432/postgres`.

**Results pipeline.** An external pipeline loads race results into `curated_rounds`, `curated_race_results` and `curated_qualifying`. The baseline creates these tables, so a fresh database is complete without the pipeline.

**Scoring** is calculated in Postgres by `score_round(subsession_id)`, which writes `race_score_results`. Triggers on the scoring inputs (results, penalties, drivers, seasons, rulesets and so on) rescore the rounds a change touches. Pages read `race_score_results_public`, which hides an unposted round's penalties from non-admins. Rounds that cannot be scored are listed in `scoring_issues`. The legacy `race_scores` rows are kept, read-only, in `race_scores_archive`.

**Storage buckets:** `logos`, `photos` and `banners` are public; `imports`, `incident-appeals` and `race-interviews` are private.

**`SECURITY DEFINER` functions** back the operations that need elevated access, such as admin user management. They are the only route to that data; client code never holds elevated credentials.

## Authentication and admin access

Users sign in with email and password through Supabase Auth. Each user has a row in `profiles` with a `role` (`admin` or `driver`) and an optional link to a driver in the roster. A linked user is shown by their driver name throughout the site. Sign-in through iRacing is planned.

To create the first admin, sign up on the site, then run this in the SQL editor with that user's id:

```sql
update profiles set role = 'admin' where id = '<auth-user-uuid>';
```

After that, admins manage other users from **Admin → Users**: linking drivers, changing roles and removing accounts.

## Results, scoring and penalties

1. Race data arrives from the results pipeline, or is uploaded under **Admin → Import**.
2. A round appears on the site once it has a season and an event. Rounds missing either show up in the **Orphaned Rounds** table on **Admin → Events**, where an admin picks the season and event to link.
3. Scoring needs the round's season to have a scoring ruleset, the event to have a race format, the season to be unlocked, and drivers to be matched by iRacing customer id.
4. Scores update automatically: the scoring triggers rescore a round whenever its results, penalties, drivers, season or ruleset change. **Admin → Seasons → Recalculate** (`rescore_season`) rescores a whole season.
5. Penalties (time, points and DSQ, with appeal values once appealed) are applied by `score_round` in the database; the results page only formats the margins and race times.
6. Incident reporting follows three admin-configurable windows. Drivers may report incidents for a set number of hours after the race. Admins then post the report, which is when penalties and adjustments become visible on the public results page. Drivers may submit appeals, with up to three files, for a set number of hours after posting.

## Deployment

The site deploys as a Cloudflare Worker with static assets. Production deploys run from GitHub Actions (`.github/workflows/deploy.yml`) on every merge to `main`, after any pending migrations apply, so code never goes live ahead of its schema. Cloudflare's own Git auto-deploy is off. The repository variable `DEPLOY_FROM_ACTIONS=true` switches the workflow on.

- **Emergency deploy without migrations:** the repo owner can run the workflow by hand with `skip_apply`.
- **Manual deploy:** `npm run deploy` still works, but skips the migration and smoke checks.

Points to know:

- `wrangler.jsonc` is the source of truth for configuration. The Worker name must match the project name in Cloudflare.
- The `vars` block must list every runtime variable. When it exists, Wrangler drops any variable set only in the dashboard.
- The Workers Free plan caps CPU at 10 ms per request and limits subrequests. Pages share data-loading work to stay within this; upgrading to Workers Paid raises the limits.
- In Supabase, add the site's URLs under **Authentication → URL Configuration** so sign-in and password-reset links redirect correctly.

A GitHub Actions workflow (`.github/workflows/ci.yml`) runs on pushes to `main` and on pull requests.

## Maintenance tasks

**Refresh the roster.** Run `npm run generate-seed -- /path/to/roster.xlsx`, then apply the regenerated `seed_teams.sql` and `seed_drivers.sql` in the SQL editor.

**Rescore a season.** Press **Recalculate** for the season on **Admin → Seasons**, or call `rescore_season(season_id)`.

**Fix a round that is missing from the site.** Open **Admin → Events → Orphaned Rounds** and link it to a season and event.

## Conventions

- **Brand colors:** blue `#4369F5`, red `#F5426E`, gold `#F5C642`.
- **Fonts:** Teko and Roboto, self-hosted as `woff2` files under `public/fonts/` (latin and latin-ext, plus Roboto's Greek subset for symbols such as Δ), with the `@font-face` rules and licence notes in `src/styles/global.css`. No page requests Google Fonts. To add a weight, add `@font-face` rules for it in both subsets, copying the `unicode-range` values Google Fonts serves; Google's files are variable fonts, so the existing files usually already cover the weight. A new or changed file gets a new version suffix (`-v2`), because `public/_headers` caches `/fonts/*` as immutable for a year.
- **Page scripts:** `src/layouts/Layout.astro` loads only the site-wide scripts. A script for one feature (local times, add to calendar, lightbox, CSV export, driver picker search, logo select, Hall of Fame filter, circuit layout detail) is imported by each page that renders its hook, or by the shell of the fragment that renders it; `tests/structure/frontEnd.test.ts` checks the list.
- **Buttons:** use the shared `.btn` classes (`btn btn-primary|danger|gold|neutral`, optional `btn-sm`/`btn-lg`) defined in `src/styles/global.css`, not one-off styling.
- **Corners:** the whole site uses a "slightly rounded" radius scale set in `tailwind.config.mjs`; change it there, not per element.
- **Themes:** light and dark are both supported.
- **Data access** goes through `src/lib`, not directly from pages.
- **Security belongs in the database** (RLS and `SECURITY DEFINER` functions), never only in the UI.
- **Schema changes** are new timestamped migrations with a down script. Do not edit applied ones.
- **Comments explain why**, not what.
- **Lint and format:** `npm run lint` (ESLint, warnings only, never blocks) and `npm run format` (Prettier). `.astro` files are excluded from Prettier because its Astro plugin changes rendered whitespace. The one-time formatting commit is listed in `.git-blame-ignore-revs`; run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once so `git blame` skips it.

## Further reading

- [`docs/development-log.md`](docs/development-log.md): the original long-form README, kept as a chronological record of how each feature was built (v0.1–v0.43). It is an archive, not maintained documentation.
- Migration file headers in `supabase/migrations/` (and `supabase/migrations/archive/` for the old ones) document the reasoning behind each schema change.
