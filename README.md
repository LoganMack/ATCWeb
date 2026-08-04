# Alpha Touring Challenge — Website

Stack: [Astro](https://astro.build) (hybrid static/on-demand rendering) + [Tailwind CSS](https://tailwindcss.com) + [Supabase](https://supabase.com) (Postgres, queried via plain `fetch` against its REST API — no SDK dependency) + [Cloudflare Pages](https://pages.cloudflare.com) hosting.

Roster and news pages are rendered on-demand at Cloudflare's edge (`export const prerender = false`) with a 60-second cache, so editing data in Supabase shows up on the site within about a minute — no rebuild or redeploy required. The homepage's news teaser works the same way. Everything else is static.

## First-time setup

1. **Install dependencies**
   ```
   npm install
   ```

2. **Create a Supabase project** at supabase.com (free tier is enough for this). In the SQL editor, run, in order:
   - `supabase/migrations/0001_init.sql` — creates all tables, lookups, and RLS policies
   - `supabase/migrations/0002_auth_admin.sql` — adds `profiles`, admin-only write policies, `teams.status`, and the `logos`/`photos` Storage buckets (see "Auth & Admin Portal" below)
   - `supabase/migrations/0003_calendar.sql` — adds `circuits` and `events` (the race calendar — see "Calendar" below)
   - `supabase/migrations/0004_champions.sql` — adds `champion_photos` and public-read access to the results pipeline's tables (see "Champions, Standings & Race Results" below) — **only needed on a database that already has the results pipeline's tables** (`race_scores`, `curated_rounds`, `curated_race_results`, `curated_qualifying`); a brand-new Supabase project without that pipeline set up yet will fail on this migration's `alter table curated_rounds ...` line, since those tables won't exist. Skip it (or comment out the top section) until that pipeline is in place.
   - `supabase/migrations/0005_round_overrides.sql` — adds `round_overrides` (lets an admin flag a specific round as a non-points exhibition even inside a real championship season — see "Championships vs. exhibitions" below) and re-grants anon `SELECT` on `drivers`, codifying a manual fix applied directly in the SQL editor for a column-level grant gap on `drivers.iracing_cust_id`. Safe to run on any database regardless of whether the results pipeline's tables exist yet.
   - `supabase/seed/seed_teams.sql`
   - `supabase/seed/seed_drivers.sql`
   - `supabase/seed/seed_news.sql`

   (`seed_teams.sql` and `seed_drivers.sql` are generated from the roster spreadsheet — see below.)

3. **Copy `.env.example` to `.env`** — already filled in with real values, nothing to look up.

4. **Run locally**
   ```
   npm run dev
   ```

5. **Deploy**: connect this repo in the Cloudflare dashboard under Workers & Pages → Create application → Pages tab → Import an existing Git repository (build command `npm run build`, output directory `dist`). Every `git push` to your main branch redeploys automatically. You don't need to add environment variables in the dashboard for this project — `wrangler.jsonc` already declares all four of them (see below) and is the single source of truth.

   Cloudflare's Git-connected builds now deploy via `wrangler deploy` rather than the older Pages-specific bundler, so `wrangler.jsonc` at the repo root (already included) is required — it tells Wrangler where the built worker (`dist/_worker.js/index.js`) and static assets (`dist/`) are. Bump `compatibility_date` in that file occasionally (any date is fine as long as it's in the past). A few things baked into this repo that fix errors Wrangler otherwise throws on deploy:
   - `public/.assetsignore` (copied into `dist/` on every build) tells Wrangler not to upload the `_worker.js` server bundle as a public static asset — it's still used as the Worker's entry point via `main`, just excluded from the public asset manifest.
   - `wrangler.jsonc`'s `vars` block declares all four `PUBLIC_*` values, including the Supabase anon key. This isn't a security shortcut: **once a `vars` block exists in `wrangler.jsonc` at all, Wrangler treats it as the complete set of runtime vars for the Worker and silently deletes anything set only in the Cloudflare dashboard that isn't also listed here** — that's what ate `PUBLIC_SUPABASE_ANON_KEY` on every deploy in earlier testing, regardless of whether it was typed as a Secret or plain Text on the dashboard side. Declaring it here instead of relying on the dashboard is what actually fixes it. This is safe specifically because a Supabase *anon* key is designed to be public and ship in client-side JS — it's not a secret, and access is controlled by the RLS policies in `supabase/migrations/0001_init.sql`, not by hiding this value. Don't put a genuinely sensitive key (a Supabase *service role* key, for example) in this file the same way.
   - If Wrangler ever warns about a Worker name mismatch, update `wrangler.jsonc`'s `"name"` field to match whatever your Cloudflare dashboard project is actually named.
   - **Why the roster/news actually failed to load in production, even after the fixes above:** `src/lib/supabase.ts` originally read `import.meta.env.PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_ANON_KEY` directly. `import.meta.env.PUBLIC_*` only gets a real value baked in at *build* time — but every page that calls Supabase has `export const prerender = false`, meaning it runs per-request on the deployed Worker, where `wrangler.jsonc`'s `vars` (or dashboard-bound variables) are only exposed via `Astro.locals.runtime.env`, not `import.meta.env`. The build was silently compiling with `undefined` every time, regardless of any dashboard/wrangler.jsonc configuration. Fixed by having `src/lib/supabase.ts` take the Supabase URL/key as an explicit parameter (`resolveSupabaseEnv(Astro.locals)`, checked in each page), preferring `Astro.locals.runtime.env` and only falling back to `import.meta.env` for contexts where that's the correct source (local `astro dev`, or a genuinely prerendered page).

## Auth & Admin Portal (v0.3)

The admin tools at `/admin` (publish news, edit drivers/teams, upload team logos, assign admin access) are gated behind a real login — no more "anyone with the anon key can technically read everything" being the only line of defense; writes now require an authenticated admin.

**Why email/password instead of "Login with iRacing":** the long-term plan is to authenticate through [iRacing's own OAuth](https://oauth.iracing.com/oauth2/book/) — its profile endpoint returns only `{ iracing_cust_id, iracing_name }` with no email, which is the cleanest way to handle EU privacy law for a series roster. iRacing has currently **paused new OAuth client registration**, so that integration can't be built yet. Everything is architected so it can be added later without reworking anything: `profiles` (added in `0002_auth_admin.sql`) is keyed to Supabase's own `auth.users.id`, not to email, and already carries `iracing_cust_id`/`iracing_name` columns that just sit `null` until that login method exists. In the meantime, Supabase's built-in email/password auth (its GoTrue REST API, called with plain `fetch` — same no-SDK approach as everything else in this repo) is what actually signs people in.

**Setting up the first admin:**
1. In the Supabase dashboard, go to Authentication → Users → Add user, and create an account with your own email and a password (or sign up through `/admin/login` once deployed — note the login page only signs *in*, it doesn't have its own signup form, specifically so random visitors can't self-register; creating the first account has to happen from the dashboard).
2. A `profiles` row is created for you automatically (role `driver`, via the `on_auth_user_created` trigger in `0002_auth_admin.sql`). Promote yourself to admin by running this in the SQL editor:
   ```sql
   update profiles set role = 'admin' where id = '<your-auth-user-uuid>';
   ```
   (Find your UUID on the same Authentication → Users screen.)
3. From then on, promoting anyone else is self-service: sign them into `/admin/login` once (which creates their `profiles` row), then use `/admin/users` to switch their role to Admin.

**How it works, if you're touching this code:**
- `src/lib/auth.ts` — the GoTrue REST calls (sign in, refresh, revoke, profile reads/writes) and the two auth cookie names/options.
- `src/middleware.ts` — runs on every on-demand request, resolves the session from cookies (silently refreshing an expired access token via the refresh token), and redirects anything under `/admin` to `/admin/login` unless the session belongs to an admin. Every `/admin/*` page can assume `Astro.locals.session` is a signed-in admin — the middleware already enforced it.
- All admin writes (`src/lib/supabase.ts`'s `create*`/`update*`/`delete*` functions) send the signed-in admin's own access token, never the anon key — Postgres Row Level Security in `0002_auth_admin.sql` is what actually allows or blocks the write. The app-layer gating in the middleware is a UX nicety; RLS is the real security boundary, same principle as the read-only policies from `0001_init.sql`.
- Team logo uploads go straight to Supabase Storage (`logos` bucket, public read / admin-only write) via `uploadToStorage()` in `src/lib/supabase.ts`.

## Sortable tables (v0.5)

Every data table on the site — the public Roster and Teams pages, and the admin Drivers/Teams/Events/Circuits/News/Users lists — can be sorted by clicking (or pressing Enter/Space on) any column header. This is one small shared script, `src/scripts/sortable-table.ts`, rather than a per-page reimplementation: any `<table data-sortable>` gets it automatically, as long as each sortable `<th>` has a `data-sort-key="foo"` and each row has a matching `<td data-col="foo">`.

By default a column sorts by its own displayed text (numeric text sorts numerically, everything else case-insensitively). When the sortable value isn't the same as what's displayed — a date that should sort chronologically rather than alphabetically, or the Roster's Penalty Points column — set `data-sort-value` on that `<td>` explicitly. Penalty Points is why this exists in the first place: it displays as e.g. "3/11", but the "/11" is just this season's point allowance (it's expected to change season to season), so `DriverRow.astro` sets `data-sort-value={driver.penalty_points}` on that cell — sorting only ever looks at the raw point count, never whatever the current allowance happens to be.

## Calendar (v0.4)

The nav's "Calendar" link and the homepage's "Upcoming Events" widget (right half of the hero) are both fed by `circuits` and `events`, added in `supabase/migrations/0003_calendar.sql`.

- **Circuits** (`/admin/circuits`) are a reusable reference table — a track gets raced across many seasons, so its name/logo only need to be entered once. Circuit logos are optional and upload to the same `logos` Storage bucket as team logos (see "Auth & Admin Portal" above); until you upload one, its slot in the calendar just shows a blank placeholder square. **Sourcing/uploading the actual circuit logos is left for later** — the admin UI and public pages both already handle a circuit having no logo gracefully.
- **Events** (`/admin/events`) are one row per race weekend: a circuit, an optional layout note (e.g. "Full Course" vs. a boot/chicane config — the same circuit can run different layouts from one event to the next, which is why `layout` lives on the event rather than the circuit), a date, and an overall format (Sprint / Endurance / Special). Every event can carry up to five sessions — Practice, Qualifying, Race 1 (required), Race 2 and Race 3 (both optional) — each with its own start time and a Dry/Mixed/Wet weather icon; Practice and Qualifying also track a length in minutes, and Qualifying/Race 1/Race 2/Race 3 also track a lap count. There's also an optional fuel-limit percentage and a link to the event's iRacing results page, both shown on the public calendar card when set.
- The public `/calendar` page lists every event (soonest first, with a separate dimmed "Past Events" section below), and the homepage hero shows just the next three, with the soonest rendered as a larger highlighted card including its full session breakdown.
- `src/lib/eventFormatting.ts` holds the shared date/time formatting and the `getEventSessions()` helper that flattens an event's five possible sessions into a display-ready list, skipping whichever of Race 2/Race 3/Practice/Qualifying weren't scheduled for that particular weekend.

## Champions, Standings & Race Results (v0.6)

Three public pages — `/champions`, `/standings`, `/results` (share a small tab bar, `HistoryTabs.astro`) — plus an admin section (`/admin/champions`) for uploading champion photos. **None of the underlying data is created by this repo.** `race_scores`, `curated_rounds`, `curated_race_results`, and `curated_qualifying` are populated by a separate, external iRacing-results import pipeline; `supabase/migrations/0004_champions.sql` only grants the anon key read access to them (they likely had no RLS configured at all before, since the import pipeline writes with a service-role key that bypasses RLS regardless) and adds the one table this repo does own, `champion_photos`.

All of the actual computation — season point totals, who's the champion, class-relative finishing position, win/podium/top-5/top-10 counts — lives in one file, `src/lib/results.ts`, specifically so there's a single place to fix if any of the business-rule assumptions below turn out to be wrong once real historical data is imported and you can eyeball the results:

- **Points**: `race_scores.total_points`, summed per round (`subsession_id` — i.e. race1+race2+race3 combined, when a round has more than one race), then the worst rounds are dropped before totaling. Drop count = **2 (baseline) + `seasons.extra_drop_weeks`** for that season. At least 1 round always counts even for a very short season, so a young class (Delta didn't exist before ATC5, Gamma before ATC16) can't get zeroed out by the drop-week math.
- **Class position** (wins/podiums/top 5s/top 10s): `race_scores.scored_position` is an *overall* field position across every class combined, not class-relative — so the per-class view doesn't use it directly (the new overall view does — see "Overall vs. per-class race results" below). Instead, `computeSeasonStandings()`/`getRoundResults()`'s per-class output re-rank each individual race themselves: take the drivers `race_scores` says were in this class for that race, look up each one's raw result in `curated_race_results`, and sort by `adjusted_position` (post-penalty) when set, falling back to `finish_position` (pre-penalty) otherwise. Whenever a row's `adjusted_position` differs from its `finish_position`, the results page shows an "Adj." badge so a penalty's effect on the result is visible, not just silently baked in.
- **Disqualifications**: a `race_scores` row with `dsq = true` is excluded from class-position ranking entirely (can never be a win/podium/top 5/top 10, and everyone behind ranks up normally) but still shows up on the race-results page, at the bottom, marked "DSQ" — and still counts toward that driver's own starts/appearances/points, since they did start the race.
- **Poles**: `race_scores.pole_bonus > 0`, counted once per round (`subsession_id`), not per individual race — races 2/3 run an inverted grid off race 1 and don't have their own qualifying, so they never earn a pole bonus. This is also why the Champions page's Poles stat shows "X% of **appearances**" while every other rate-based stat (wins, podiums, top 5s, top 10s) shows "X% of **starts**."
- **Starts vs. appearances**: a "start" is one `race_scores` row (one individual race); an "appearance" is one distinct round (`subsession_id`) — i.e. showing up for race1 only vs. also running race2/race3 are both 1 appearance, but 1 vs. up to 3 starts.

If any of this doesn't match how the league's scoring actually works once you can check it against real results, it's all contained in `src/lib/results.ts` — nothing on the page side needs to change to fix it.

The Champions page defaults to Alpha and lets you switch class via `?class=Gamma` links (a real page navigation, not a client-side toggle — computing a season's standings isn't free, so it only happens for the class you're actually looking at). Uploading a champion's (up to 3) photos happens at `/admin/champions` → pick a season/class → upload; the computed champion's name is shown for reference so it's obvious who you're uploading for. Each photo click-enlarges (`src/scripts/lightbox.ts`, shared with the public Champions page), and each upload/delete redirects back to the same page on success instead of re-rendering in place — the earlier version skipped that, which meant `hard-form-submit.ts` fell back to its fragile `document.write()` path and every photo upload felt like it required manually going back.

### Overall vs. per-class race results (v0.7)

A round's results page (`/results/[subsessionId]`) has two views, toggled at the top of the page:

- **Overall** (the default) — every class combined, ranked by `race_scores.scored_position`, which is what the points system is actually based on. Each row also shows which class that driver races in, color-coded the same way the Roster's class badge is (`src/lib/classColors.ts`, shared between the two).
- **Per Class** — the original view: each class gets its own ranked table, re-derived from `curated_race_results` the same way `computeSeasonStandings()` does (see above). No Class column here since every row in a given table is already the same class.

Both views are rendered by one shared component, `src/components/ResultsTable.astro`, with a fixed column order: **Pos, Driver / Number, Class (overall view only), Margin, Start, Incidents, Laps, Points**. There's no separate column for pole/penalty-adjustment/DNF anymore — those show as small inline markers instead: a gold "P" superscript next to Start for a pole, a pink "*" superscript next to Pos for a post-penalty adjustment (hover for what it changed from), and a small tag next to the driver's name for a non-"Running" `reason_out` (e.g. "DNF"). **Margin** is the gap to the leader, formatted `xx.xxx` seconds, from `curated_race_results.interval_ten_thousandths` (`formatMargin()` in `src/lib/results.ts`) — the leader's own row (a 0.000 gap) shows "—" instead of "0.000", same as a missing interval.

**Laps** shows `laps_complete`, with a small "N led" subscript underneath from `laps_led` when a driver led at least one lap. **Points** shows `race_scores.total_points` (a generated column: `finish_points + class_points + finesse_bonus + pole_bonus + points_deduction`), with a small breakdown underneath — `class_points` alone (Delta/Gamma's per-race class-position bonus; always 0 for Alpha) and `finesse_bonus + pole_bonus + points_deduction` combined as "bonus" (everything in the total besides the base overall-position points and class points) — shown only when nonzero, so most rows just show a plain point total. See `RaceResultRow.classPoints`/`bonusPoints` in `src/lib/results.ts`. The full points system (base points by overall position, class points, the Sublime Finesse and Class Pole bonuses) has been in place since ATC16; a page showing that reference table for visitors is a later addition, not built yet.

Each race's table is labeled with a small "Race N" heading instead of that being baked into a table column header.

### Championships vs. exhibitions (v0.7)

Not every season/round on record counts toward standings and champions. Two independent mechanisms exclude non-points racing, both enforced inside `computeSeasonStandings()`/`getChampions()` so nothing on the page side can accidentally include one:

- **Season-level, name-derived, no schema needed**: a season only counts if its `name` matches `/^ATC\d+$/` (e.g. "ATC17") — anything else is treated as a non-points-paying/for-fun event. `isChampionshipSeason()` in `src/lib/results.ts` is the single source of truth for this; the `/results` and `/standings` season pickers use it too (`/results`' picker splits into "Championships"/"Exhibitions" `<optgroup>`s so both are still browsable, just clearly labeled — `/standings` only ever offers championship seasons, since an exhibition season would just show "no standings").
- **Round-level, admin-managed**: an individual round *inside* an otherwise-real championship season can also be a non-points exhibition — the concrete case that came up is a season's pre-season/first race run before points start counting. There's no existing column for this (and `curated_rounds` isn't a table this repo can alter — see the note on `supabase/migrations/0004_champions.sql`), so `0005_round_overrides.sql` adds a small sibling table, `round_overrides (subsession_id, is_exhibition, note)`. A signed-in admin sees a "Flag this round as an exhibition" / "Unflag" button at the bottom of that round's results page (visible only when signed in as admin); flagged rounds are excluded from every season's standings/champions computation via `getExhibitionRoundIds()`.
- **Displayed round numbers skip exhibitions entirely**: an exhibition round is labeled "Exhibition" instead of "Round N", and doesn't consume a number — flagging round 1 as an exhibition makes round 2 become "Round 1", rather than leaving a gap. `computeDisplayRoundNumbers()` in `src/lib/results.ts` recomputes this chronologically within a season every time, ignoring `curated_rounds.round_number` (the pipeline's own numbering, which doesn't know about exhibitions) entirely.

### Click-to-enlarge photos (v0.7)

`src/scripts/lightbox.ts` (loaded on every page via `Layout.astro`) turns any `<button data-lightbox data-lightbox-src="...">` into a click-to-enlarge trigger — a single delegated click listener opens a full-screen overlay with the full-size image, closable via the × button, clicking the backdrop, or Escape. Used on the public Champions page's photos and the admin champion-photo upload previews. The Champions page photo layout is one large photo (`aspect-video`, matching the expected 800×450 uploads) with the other two shown smaller side-by-side underneath, rather than three equal-sized photos.

## Re-importing the roster later

Whenever the roster spreadsheet changes:
```
python3 supabase/seed/generate_seed.py path/to/roster.xlsx
```
This regenerates `supabase/seed/seed_teams.sql` and `seed_drivers.sql`. Re-run them in the Supabase SQL editor — both are upserts, safe to run repeatedly.

## Known placeholders — swap these out

- **Colors** (`tailwind.config.mjs`): resolved — using the confirmed brand hex codes (`#F5426E` pink, `#4369F5` blue, `#F5C642` gold).
- **Fonts**: Teko (display) + Roboto (body) load from Google Fonts, no files needed. Teko is standing in for Cuatra pending a confirmed commercial license — see the note in `src/styles/global.css` for why a "free for personal use" font license likely doesn't cover a public organization's branding even if it's non-profit (that's not legal advice — check the license text that came with your Cuatra files, or ask the foundry, if you want certainty).
- **Logo**: resolved — the real ATC18 logo (`public/logos/atc18-white.png` for the dark nav, `atc18-black.png` also included for any light-background use) pulled from `E:\ATC Media\Logos` on your machine.
- **News cover image**: resolved — `public/images/news/swirydowicz-champion-atc17.jpg`, referenced directly in `seed_news.sql` as a static site asset (no Supabase Storage needed for this one).
- **Favicon**: resolved — generated from your `favicon.png` into `public/favicon.ico` (16/32/48px), `public/favicon-192.png`, and `public/apple-touch-icon.png` (180px), wired up in `src/layouts/Layout.astro`.
- **Circuit logos**: still a placeholder — no circuit has a logo uploaded yet, so cards fall back to a blank square. Upload one per circuit from `/admin/circuits` whenever you have them; nothing else needs to change.
- **Homepage background image**: still a placeholder — the hero section in `src/pages/index.astro` currently references `public/images/hero-bg.jpg`, which doesn't exist yet, so you'll just see the dark background + radial glow until you add it. Drop your image at exactly that path (`public/images/hero-bg.jpg`) and it'll pick it up automatically on the next build/deploy — no code change needed. Sizing guidance:
  - **Dimensions**: 2560×1440px minimum (16:9). The image is stretched to `cover` behind the hero text, so on very wide monitors it can be cropped horizontally — a subject that's reasonably centered (not off in a corner) holds up best across screen sizes.
  - **Format**: JPG, optimized to roughly 300–500KB (this loads on every visit to `/`, so it's worth compressing — TinyPNG or Squoosh both work well).
  - **Contrast/legibility**: a dark, semi-transparent overlay (`bg-brand-ink/70`) plus the existing blue radial glow are already layered on top of whatever image you add, so the white headline text stays readable regardless — but a photo that's already darker or lower-contrast in its upper-middle area (where the headline sits) will look best.

No known placeholders remain for v0.2. The homepage background image and circuit logos are the only open items as of v0.4.

## A note on this project's first build

This was scaffolded in a sandboxed session without access to the npm registry, PyPI, or Supabase's API (only GitHub was reachable), so none of it could be `npm install`ed or run in that session — every file was hand-written instead of generated by `npm create astro` and friends. It's worth running `npm install && npm run build` yourself as a first check before deploying, in case anything needs a small fix.
