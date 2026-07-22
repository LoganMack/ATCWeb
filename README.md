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

No known placeholders remain for MVP1.

## A note on this project's first build

This was scaffolded in a sandboxed session without access to the npm registry, PyPI, or Supabase's API (only GitHub was reachable), so none of it could be `npm install`ed or run in that session — every file was hand-written instead of generated by `npm create astro` and friends. It's worth running `npm install && npm run build` yourself as a first check before deploying, in case anything needs a small fix.
