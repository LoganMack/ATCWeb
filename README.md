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
- **Homepage background image**: still a placeholder — the hero section in `src/pages/index.astro` currently references `public/images/hero-bg.jpg`, which doesn't exist yet, so you'll just see the dark background + radial glow until you add it. Drop your image at exactly that path (`public/images/hero-bg.jpg`) and it'll pick it up automatically on the next build/deploy — no code change needed. Sizing guidance:
  - **Dimensions**: 2560×1440px minimum (16:9). The image is stretched to `cover` behind the hero text, so on very wide monitors it can be cropped horizontally — a subject that's reasonably centered (not off in a corner) holds up best across screen sizes.
  - **Format**: JPG, optimized to roughly 300–500KB (this loads on every visit to `/`, so it's worth compressing — TinyPNG or Squoosh both work well).
  - **Contrast/legibility**: a dark, semi-transparent overlay (`bg-brand-ink/70`) plus the existing blue radial glow are already layered on top of whatever image you add, so the white headline text stays readable regardless — but a photo that's already darker or lower-contrast in its upper-middle area (where the headline sits) will look best.

No known placeholders remain for v0.2. The homepage background image is the only open item for v0.3.

## A note on this project's first build

This was scaffolded in a sandboxed session without access to the npm registry, PyPI, or Supabase's API (only GitHub was reachable), so none of it could be `npm install`ed or run in that session — every file was hand-written instead of generated by `npm create astro` and friends. It's worth running `npm install && npm run build` yourself as a first check before deploying, in case anything needs a small fix.
