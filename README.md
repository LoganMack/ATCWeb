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

| Area | What it provides |
| --- | --- |
| Home | Next event, latest news and league links |
| News | Articles, including auto-generated race recaps |
| Roster and driver profiles | Teams, drivers, per-driver career pages |
| Calendar | Upcoming and past events with local-time display and add-to-calendar |
| Race results | Race, qualifying and practice results with penalties, best laps and expandable rows |
| Incident reports | Per-race incident list with a detail view and appeal submission |
| Standings | List, Matrix and Graph views; Season, Championship and Class filters; a "Standings by Round" slider; team standings |
| Champions, Awards, Hall of Fame | League history and honours |
| Driver and team stats | Career and season statistics |
| Circuits and media | Circuit records and layouts, photo galleries |

### Admin portal

Everything is managed in the browser under `/admin`: seasons, events, rulesets, results imports, penalties and penalty offenses, incident reporting and appeals, drivers, teams, organizations, circuits, car logos, news, awards, champions, page banners, site properties, users, and an activity log. Admin pages are only available to signed-in users with the `admin` role.

## Architecture

- **Hybrid rendering.** Astro runs with `output: 'hybrid'` on the Cloudflare adapter. Most data-driven pages set `export const prerender = false` and render at the edge on each request.
- **Edge caching.** Public pages send `Cache-Control: public, s-maxage=…` and are cached at Cloudflare, so data edited in Supabase appears within about a minute without a redeploy. `src/middleware.ts` never caches responses for signed-in users, admins or broadcasters.
- **No Supabase SDK.** `src/lib/supabase.ts` talks to PostgREST, GoTrue and Storage with plain `fetch`, which keeps the Worker bundle small and CPU time low.
- **Security lives in the database.** Row Level Security policies and `SECURITY DEFINER` functions are the access boundary. The anon key shipped to the browser is public by design and grants nothing the policies do not allow.
- **Small client scripts.** Interactivity (sortable tables, expandable rows, lightbox, CSV export, theme toggle) is plain TypeScript in `src/scripts`, with no UI framework.

## Getting started

### Prerequisites

- Node.js 20 or newer
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

1. In the Supabase SQL editor, run every file in `supabase/migrations/` in numeric order.
2. Run the seed files in `supabase/seed/` (`seed_teams.sql`, `seed_drivers.sql`, `seed_news.sql`).

See [Database](#database) for the one caveat about the results pipeline tables.

### Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local development server |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Preview the production build locally |
| `npm run deploy` | Build and deploy with Wrangler |
| `npm run generate-seed` | Regenerate roster seed SQL from the roster spreadsheet |
| `npx astro check` | Type-check `.astro` and `.ts` files |

## Configuration

The site reads four runtime variables. All are public values and are safe to commit.

| Variable | Purpose |
| --- | --- |
| `PUBLIC_SUPABASE_URL` | Supabase project URL |
| `PUBLIC_SUPABASE_ANON_KEY` | Supabase anon (public) key |
| `PUBLIC_DISCORD_URL` | Discord invite link shown in the menu |
| `PUBLIC_REDBUBBLE_URL` | Merchandise link shown in the menu |

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
  migrations/     Numbered SQL migrations (applied by hand)
  seed/           Seed data and the roster seed generator
docs/             Project documentation and history
public/           Static assets and CSV import templates
wrangler.jsonc    Cloudflare Workers configuration
```

Key modules in `src/lib`:

| Module | Responsibility |
| --- | --- |
| `supabase.ts` | Fetch-based Supabase client and environment resolution |
| `auth.ts` | Sessions, roles and display names |
| `results.ts` | Results, standings and season context |
| `penalties.ts`, `penaltyActions.ts` | Penalty engine and admin actions |
| `incidents.ts`, `incidentReports.ts`, `incidentAppeals.ts` | Incident reporting, posting and appeals |
| `raceResultsImport.ts`, `importTemplates.ts`, `orphanRounds.ts` | Results import and orphaned-round handling |
| `newsRecap.ts` | Automatic race recap articles |
| `siteSettings.ts`, `pageBanners.ts`, `activityLog.ts` | Site configuration and auditing |

## Database

Schema changes are numbered SQL files in `supabase/migrations/`. They are applied by hand in the Supabase SQL editor, in numeric order. Each file's header comment explains what it does and why.

**Results pipeline.** Race results are loaded by an external pipeline into `curated_rounds`, `curated_race_results`, `curated_qualifying` and `race_scores`. Those tables must exist before the migrations that extend them will run, so on a brand-new project you may need to skip or defer those migrations until the pipeline is in place.

**Scoring** is calculated in Postgres by `recalculate_race_scores(subsession_id)`.

**Storage buckets:** `logos`, `photos`, `banners` and `imports` (public), plus a private bucket for incident appeal attachments.

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
4. Scores are recalculated from the admin pages after any change, or by calling `recalculate_race_scores`.
5. The penalties engine applies position and point adjustments from the penalty offense catalogue.
6. Incident reporting follows three admin-configurable windows. Drivers may report incidents for a set number of hours after the race. Admins then post the report, which is when penalties and adjustments become visible on the public results page. Drivers may submit appeals, with up to three files, for a set number of hours after posting.

## Deployment

The site deploys as a Cloudflare Worker with static assets, using Wrangler.

```bash
npm run deploy
```

Connecting the repository to Cloudflare for Git-based deploys also works. Points to know:

- `wrangler.jsonc` is the source of truth for configuration. The Worker name must match the project name in Cloudflare.
- The `vars` block must list every runtime variable. When it exists, Wrangler drops any variable set only in the dashboard.
- The Workers Free plan caps CPU at 10 ms per request and limits subrequests. Pages share data-loading work to stay within this; upgrading to Workers Paid raises the limits.
- In Supabase, add the site's URLs under **Authentication → URL Configuration** so sign-in and password-reset links redirect correctly.

A GitHub Actions workflow (`.github/workflows/ci.yml`) runs on pushes to `main` and on pull requests.

## Maintenance tasks

**Refresh the roster.** Run `npm run generate-seed -- /path/to/roster.xlsx`, then apply the regenerated `seed_teams.sql` and `seed_drivers.sql` in the SQL editor.

**Rescore a season.** Run `recalculate_race_scores` for each race in the season, or trigger a rescore from the admin pages.

**Fix a round that is missing from the site.** Open **Admin → Events → Orphaned Rounds** and link it to a season and event.

## Conventions

- **Brand colors:** blue `#4369F5`, red `#F5426E`, gold `#F5C642`.
- **Fonts:** Teko and Roboto; see the licence note in `src/styles/global.css`.
- **Themes:** light and dark are both supported.
- **Data access** goes through `src/lib`, not directly from pages.
- **Security belongs in the database** (RLS and `SECURITY DEFINER` functions), never only in the UI.
- **Schema changes** are new numbered migrations. Do not edit applied ones.
- **Comments explain why**, not what.

## Further reading

- [`docs/development-log.md`](docs/development-log.md): the original long-form README, kept as a chronological record of how each feature was built (v0.1–v0.43). It is an archive, not maintained documentation.
- Migration file headers in `supabase/migrations/` document the reasoning behind each schema change.
