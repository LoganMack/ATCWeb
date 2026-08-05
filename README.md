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
   - `supabase/migrations/0006_champion_photos_expand.sql` — widens `champion_photos.sort_order` from 3 slots (0-2) to 5 (0-4). Only needed if 0004 has already run on this database.
   - `supabase/migrations/0007_race_links.sql` — adds `race_links` (optional per-race iRacing results / replay / broadcast links — see "Per-race external links" below). Safe to run on any database regardless of whether the results pipeline's tables exist yet.
   - `supabase/migrations/0008_team_rosters.sql` — adds `team_rosters` (season-scoped team membership — see "Team rosters & race-results team logos" below). Safe to run on any database regardless of whether the results pipeline's tables exist yet.
   - `supabase/migrations/0009_car_logos.sql` — adds `car_logos` (admin-configurable car_name → logo lookup — see "Car logos" below). Safe to run on any database regardless of whether the results pipeline's tables exist yet.
   - `supabase/migrations/0010_circuit_layouts.sql` — adds `circuit_layouts` (per-circuit lap records — see "Circuit layouts" below). Safe to run on any database regardless of whether the results pipeline's tables exist yet.
   - `supabase/migrations/0011_driver_signup_date.sql` — adds `drivers.sign_up_date`. Safe to run on any database.
   - `supabase/migrations/0012_circuit_location.sql` — adds `circuits.location` (powers the public Circuits page — see below). Safe to run on any database.
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

The Champions page defaults to Alpha and lets you switch class via `?class=Gamma` links (a real page navigation, not a client-side toggle — computing a season's standings isn't free, so it only happens for the class you're actually looking at). Uploading a champion's (up to 5) photos happens at `/admin/champions` → pick a season/class → upload; the computed champion's name is shown for reference so it's obvious who you're uploading for. Each photo click-enlarges (`src/scripts/lightbox.ts`, shared with the public Champions page), and each upload/delete redirects back to the same page on success instead of re-rendering in place — the earlier version skipped that, which meant `hard-form-submit.ts` fell back to its fragile `document.write()` path and every photo upload felt like it required manually going back.

### Overall vs. per-class race results (v0.7)

A round's results page (`/results/[subsessionId]`) has two views, toggled at the top of the page:

- **Overall** (the default) — every class combined, ranked by `race_scores.scored_position`, which is what the points system is actually based on. Each row also shows which class that driver races in, color-coded the same way the Roster's class badge is (`src/lib/classColors.ts`, shared between the two).
- **Per Class** — the original view: each class gets its own ranked table, re-derived from `curated_race_results` the same way `computeSeasonStandings()` does (see above). No Class column here since every row in a given table is already the same class.

Both views are rendered by one shared component, `src/components/ResultsTable.astro`, with a fixed column order: **Pos, Driver / Number, Class (overall view only), Margin, Start, Incidents, Laps, Class Points**. There's no separate column for pole/penalty-adjustment anymore — those show as small inline markers instead: a gold "P" superscript next to Start for a pole, a gold "I" superscript next to Incidents when `finesse_bonus > 0` (the "3 incidents or less" bonus was actually awarded that race — same "driven by whether the bonus was awarded, not a re-derived raw threshold" approach as the pole marker), and a pink "*" superscript next to Pos for a post-penalty adjustment (hover for what it changed from). Every row is a fixed height (`h-8` wrappers around the Laps/Points cell contents) regardless of whether that row's subscript lines are actually present, so a table with a mix of "plain" and "detailed" rows still lines up cleanly.

**Margin** is the gap to the leader, formatted `xx.xxx` seconds, from `curated_race_results.interval_ten_thousandths` (`formatMargin()` in `src/lib/results.ts`) — the leader's own row (a 0.000 gap) shows "—" instead of "0.000", same as a missing interval. A *negative* interval is iRacing's way of flagging that a driver finished one or more laps down rather than showing a real (and misleading) time gap — that shows as **"-xL"** instead, where x is the leader's `laps_complete` minus this driver's.

**Result tags**: instead of a single hardcoded "disconnected"-style tag, each row carries a general-purpose `tags: string[]` (`RaceResultRow.tags`), rendered as small pills next to the driver's name — dynamic by design so a future tag (e.g. a penalty) can sit alongside without another schema/UI change. Today the only tag is **"Unclassified"**, shown whenever `race_scores.classified` is false — the results pipeline itself computes that (a driver who finished under 50% of the leader's laps doesn't score points and is unclassified); the app trusts that field rather than re-deriving the 50% threshold.

**Team**: each row also shows the team the driver raced for that race (`race_scores.team_id`) — its uploaded logo, or an acronym-of-initials placeholder tile when the team has no logo (`src/components/TeamLogo.astro` / `src/lib/teamLogo.ts`), same convention used on the Roster and Teams pages.

**Laps** shows `laps_complete`, with a small "N led" subscript underneath from `laps_led` when a driver led at least one lap. **Class Points** shows `race_scores.total_points` as the main figure, with a single combined "bonus" figure underneath — `class_points + finesse_bonus + pole_bonus + points_deduction` (everything in the total besides the base overall-position points), shown only when nonzero via `RaceResultRow.bonusPoints`. The full points system (base points by overall position, class points, the Sublime Finesse and Class Pole bonuses) has been in place since ATC16; a page showing that reference table for visitors, and a possible admin screen for configuring per-season bonus-point values (pole/finesse splits across a round's races, etc.), are later additions, not built yet.

Each race's table is labeled with a small "Race N" heading instead of that being baked into a table column header.

### Championships vs. exhibitions (v0.7)

Not every season/round on record counts toward standings and champions. Two independent mechanisms exclude non-points racing, both enforced inside `computeSeasonStandings()`/`getChampions()` so nothing on the page side can accidentally include one:

- **Season-level, name-derived, no schema needed**: a season only counts if its `name` matches `/^ATC\d+$/` (e.g. "ATC17") — anything else is treated as a non-points-paying/for-fun event. `isChampionshipSeason()` in `src/lib/results.ts` is the single source of truth for this; the `/results` and `/standings` season pickers use it too (`/results`' picker splits into "Championships"/"Exhibitions" `<optgroup>`s so both are still browsable, just clearly labeled — `/standings` only ever offers championship seasons, since an exhibition season would just show "no standings").
- **Round-level, admin-managed**: an individual round *inside* an otherwise-real championship season can also be a non-points exhibition — the concrete case that came up is a season's pre-season/first race run before points start counting. There's no existing column for this (and `curated_rounds` isn't a table this repo can alter — see the note on `supabase/migrations/0004_champions.sql`), so `0005_round_overrides.sql` adds a small sibling table, `round_overrides (subsession_id, is_exhibition, note)`. A signed-in admin sees a "Flag this round as an exhibition" / "Unflag" button at the bottom of that round's results page (visible only when signed in as admin); flagged rounds are excluded from every season's standings/champions computation via `getExhibitionRoundIds()`.
- **Displayed round numbers skip exhibitions entirely**: an exhibition round is labeled "Exhibition" instead of "Round N", and doesn't consume a number — flagging round 1 as an exhibition makes round 2 become "Round 1", rather than leaving a gap. `computeDisplayRoundNumbers()` in `src/lib/results.ts` recomputes this chronologically within a season every time, ignoring `curated_rounds.round_number` (the pipeline's own numbering, which doesn't know about exhibitions) entirely.

### Click-to-enlarge photos (v0.7)

`src/scripts/lightbox.ts` (loaded on every page via `Layout.astro`) turns any `<button data-lightbox data-lightbox-src="...">` into a click-to-enlarge trigger — a single delegated click listener opens a full-screen overlay with the full-size image, closable via the × button, clicking the backdrop, or Escape. Used on the public Champions page's photos and the admin champion-photo upload previews. The Champions page photo layout is one large photo (`aspect-video`, matching the expected 800×450 uploads, sized at 264px — 20% larger than the original 220px, to close more of the gap against the stats column) with 4 more shown smaller underneath in two rows of 2 (`0006_champion_photos_expand.sql` widened the slot limit from 3 to 5) — the second row exists mainly to give the photo column enough height to come closer to matching the stats column's height next to it, rather than leaving a lot of empty space at the bottom of the card. The card no longer shows a redundant "1st · Champion" badge next to the driver's name — the card's entire premise is that this driver *is* the champion, so it didn't add anything.

### Per-race external links (v0.7)

Each individual race (not round — a round with 3 races isn't necessarily 1 iRacing subsession) can have three independent, optional links, stored in `race_links` (`0007_race_links.sql`, keyed on `(subsession_id, race_number)`, same non-FK relationship to the results pipeline's tables as `round_overrides`):

- **iRacing Results** — built from a stored `iracing_subsession_id` via `iracingResultsUrl()` in `src/lib/results.ts`, rather than storing a full URL, so the link format only needs updating in one place if it ever changes. This is deliberately a *different* id than this app's own `subsession_id` grouping key.
- **Download Replay** — an external link (e.g. Google Drive) to the replay file. Replays are large, so this repo deliberately doesn't host them itself.
- **Watch Broadcast** — almost always a YouTube link.

All three show as small blue pill buttons (matching every other primary button/CTA on the site — `bg-brand-primary`) next to each race's "Race N" heading when set. A signed-in admin additionally sees an "Edit links" disclosure there (a `<details>` — no JS needed to open it) with a small form for all three fields, submitting via the same PRG pattern as everything else on this page. See `getRaceLinksForSubsession()`/`upsertRaceLinks()` in `src/lib/supabase.ts`.

### Team rosters & race-results team logos (v0.8)

`teams.id`/`drivers.id` are shared across every season, but a team's actual lineup changes every season — `team_rosters` (`0008_team_rosters.sql`) tracks that separately: `(season_id, team_id, driver_id)`, with two rules enforced by a database trigger (not just the admin UI, so a bad request can't bypass them): at most **4 drivers** per team per season (the format's cap is 3 today, but was 4 in earlier seasons — 4 is kept as the ceiling so older seasons stay representable), and a driver can only be on one team's roster per season. Manage it at `/admin/teams/[id]` → "Season Roster": pick a season, add/remove drivers from that team's roster for it.

The race-results team display (see above) deliberately reads `race_scores.team_id` directly rather than this roster table — that field already records the correct team for that specific race entry, no season lookup needed. The roster table exists as its own source of truth for "who was on this team's roster, season by season" (useful for a future team-history view), independent of any one race's data.

### Visual polish (v0.8)

Corner radius was reduced one step across the whole site's Tailwind scale (`rounded-2xl`→`rounded-xl`, `rounded-xl`→`rounded-lg`, `rounded-lg`→`rounded-md`, and the pill-shaped `rounded-full` buttons/tags→`rounded-lg`) — small logo/avatar images (plain `rounded`) were left as-is since they were already the smallest step on the scale. Radio/checkbox inputs (admin forms) now get `accent-color: theme('colors.brand.primary')` in `src/styles/global.css`, since without it browsers render their own default accent blue instead of the site's actual ATC blue (`#4369F5`, `brand.primary`/`brand.blue` in `tailwind.config.mjs`) — everywhere else on the site was already using the correct brand color.

## Overall vs. per-class season standings (v0.9)

`/standings` now has the same Overall / Per Class toggle as the race results page, defaulting to Overall. **Per Class** is the original behavior (`computeSeasonStandings()`, one class at a time). **Overall** is a new computation, `computeOverallSeasonStandings()` in `src/lib/results.ts`: every class combined into one table, scored with the same formula Alpha already effectively uses (`finish_points + finesse_bonus + pole_bonus + points_deduction`) — deliberately *excluding* `class_points`, Delta/Gamma's own per-race class-position bonus that Alpha never earns, so every class is judged on the same basis rather than Gamma/Delta having a structural leg up (Logan: "it should essentially be the alpha standings with everyone included"). Wins/podiums/top 5s/top 10s in this view come straight from `race_scores.scored_position` (the overall field position) rather than the per-class re-derivation the Per Class view uses. The Overall table adds a Class column so it's still clear which class each driver races in.

## Car logos & team/car logos on standings (v0.9)

Race results (and now standings) show the car a driver used as a small logo, the same way team logos work — `curated_race_results.car_name` is the per-race source (unlike `drivers.car`, which is just that driver's *current* car and isn't season/race-specific). `car_logos` (`0009_car_logos.sql`) is a simple admin-managed `car_name → logo_url` lookup; manage it at `/admin/car-logos`, which lists every car currently assigned to a driver (a practical stand-in for "every car in the data" — scanning the full historical results table for distinct names isn't practical over plain PostgREST) plus a manual "add a car by name" option for older cars. A car (or team) with no logo configured falls back to an acronym-of-initials placeholder tile, same as team logos — `src/components/TeamLogo.astro` is genuinely generic despite the name, used for both. Hovering any logo (team or car, placeholder or real) now shows its full name — previously only the placeholder tiles did that.

On the results page, both the team and car logo sit immediately to the right of the driver's car number. On the standings page, a driver can show *multiple* team and/or car logos if they raced under more than one that season — each logo's hover text is a small stat readout instead of just a name: a car logo says how many races it was used in; a team logo says how many races the driver raced under that team **and** how many of those races they were one of the team's top 2 point scorers in that specific race — the rule that decides whose points actually count toward the team championship that race. Both are computed once per season in `getSeasonCarTeamStats()`, independent of whichever standings view (Overall/Per Class) is currently showing.

## Circuit layouts (v0.9)

A circuit can be run in more than one configuration (full course vs. a shorter layout, etc.), each with its own lap record. `circuit_layouts` (`0010_circuit_layouts.sql`) is a normal child table of `circuits`: any number of layouts per circuit, each with a name, length (km), lap record, record holder, and record date. Manage them at `/admin/circuits/[id]` → "Layouts". Shown publicly at `/circuits` (see below); events still store their layout as free text (`events.layout`) rather than referencing a specific `circuit_layouts` row, so wiring that connection up is a reasonable next step, not done here.

**Lap record storage** (`0013_circuit_layout_lap_record_seconds.sql`): `lap_record_seconds` stores the record as a plain number of seconds to the nearest thousandth (e.g. `102.512`) — matching the format imported data actually comes in as — rather than a pre-formatted string. `formatLapTime()` in `src/lib/supabase.ts` converts that into the conventional "01:42.512" (`MM:SS.mmm`, zero-padded) for display; the admin form takes the raw seconds and shows a live "= 01:42.512" preview next to the field so entering it by hand doesn't require doing the minutes/seconds math yourself.

## Public Circuits page (v0.10)

`/circuits` is a fourth tab on `HistoryTabs` (Champions / Standings / Race Results / Circuits), listing every circuit with its logo, name, and location (`circuits.location`, `0012_circuit_location.sql` — free text like "Le Mans, France", nothing else in the app queries it structurally). Each row is a `<details>` — click anywhere on it to expand and show every one of that circuit's layouts (name, length, lap record + holder + date), no JS needed for the toggle. A circuit with no layouts recorded yet just shows "No results." when expanded.

## Generic "No results." empty states (v0.10)

Every "this list/table is empty" message across the site (admin list pages, the roster's status/class filters, results/standings/champions with nothing to show, the homepage's upcoming-events widget, etc.) now reads exactly **"No results."** — no more bespoke phrasing like "No champions on record yet for Alpha" or "No circuits yet — create one first." This does mean a couple of admin pages that used to point you at what to do next (e.g. "no circuits yet, create one first" on the New Event form) now just say "No results." instead — consistency was the explicit ask here over per-page helpfulness.

## Driver Roster tweaks (v0.10)

A few changes to `/roster` and its admin counterpart:
- The **Car** column is gone from the roster table — a driver can swap cars once a season without penalty, so "current car" isn't meaningful roster-wide (it still shows correctly per-race on Race Results, since that's sourced from `curated_race_results.car_name` for that specific race — see "Car logos" above).
- The team logo moved from next to the driver's name to next to the team name, in the Team column, where it visually belongs.
- The "X drivers currently on the books" subtitle is gone.
- Added a **Signed Up** column (`drivers.sign_up_date`, `0011_driver_signup_date.sql`), entered manually for now at `/admin/drivers/[id]`. This is laying groundwork for later: once drivers can sign up on the site themselves, this date (plus 90-day inactivity tracking and a "Veteran" exemption — 75+ appearances or an Alpha championship — that permanently protects a driver from ever being marked Inactive) is meant to drive automatic car-number release when an inactive driver's number becomes available again. None of that automation exists yet; only the column and its manual entry point do.

## Display formatting: dates, lap times, layout names (v0.12)

- **Dates** now display consistently as "Month D, YYYY" (e.g. "August 5, 2026") everywhere a date appears — driver sign-up date, circuit layout lap-record date, news post date, race round date. Centralized in a `formatDate()` helper in `src/lib/supabase.ts` (handles both plain `'YYYY-MM-DD'` columns and full ISO timestamps, and — same fix `formatEventDate()` already had — parses date-only strings as local calendar dates so the day never shifts back a day in negative-UTC-offset timezones). Event dates keep going through `formatEventDate()`/`formatEventDateShort()` in `src/lib/eventFormatting.ts`; `formatEventDate()` dropped the weekday-name prefix it used to include, to match the new site-wide format. `formatEventDateShort()` (the compact "Aug 15" used in the homepage's small upcoming-event teaser) was deliberately left alone — it's a tight-space abbreviation, not a full date, so it seemed like the wrong thing to force into "Month D, YYYY"; say the word if you'd rather it match too.
- **Lap times** no longer zero-pad the minutes digit — `formatLapTime()` now renders 102.512 seconds as "1:42.512" instead of "01:42.512" (seconds/milliseconds keep their fixed-width padding, since those are always exactly 2/3 digits).
- A layout named exactly "N/A" (the placeholder used when a circuit only has one configuration) now displays as **"Full Course"** on both the public Circuits page and the admin circuit editor's layout list — display-only via a new `displayLayoutName()` helper, the stored value is untouched, and the admin edit form's "Layout name" input still shows/edits the raw stored value.
- **Roster load errors** now show the actual error message (plus a hint about pending migrations) instead of a generic "check your env vars" line — same pattern as the Race Results page. If `/roster` was showing that generic message for you: the new error text will say what's actually wrong, but the most likely cause is `supabase/migrations/0011_driver_signup_date.sql` not having been run yet against your live database — PostgREST fails an entire query (not just one column) whenever any selected column doesn't exist, and `sign_up_date` was added to the roster query in v0.10.

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
