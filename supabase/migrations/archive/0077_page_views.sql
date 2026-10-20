-- Alpha Touring Challenge — page_views
--
-- Backs the new "site analytics" block on the admin dashboard (unique
-- visitors, top regions, traffic-by-hour). There was no analytics of any
-- kind on the site before this — Logan asked for something self-contained
-- rather than wiring in a third-party service (Cloudflare Web Analytics,
-- Plausible, etc.), so this is a deliberately small first-party table plus
-- one aggregation RPC, populated by a server-side hook in src/middleware.ts
-- (never a client-side beacon script — no cookies, nothing for an ad
-- blocker to strip, and it can't be skewed by JS being disabled).
--
-- PRIVACY DESIGN — read this before changing what gets written here:
--   - No raw IP address is ever stored. `visitor_hash` is
--     sha256(ip + user-agent + a fixed salt + the UTC calendar date),
--     computed in src/middleware.ts and truncated to 32 hex chars. Salting
--     with a fixed, non-secret string (rather than a proper per-deploy
--     secret, which this project has no mechanism for — see wrangler.jsonc's
--     "vars" comment on why only *public* values live there) isn't meant to
--     resist a determined attacker with source access and a candidate IP —
--     it's meant to keep the raw IP out of this table entirely, which is
--     the actual goal.
--   - The hash rotates every UTC day on purpose. That makes "unique
--     visitors" an honest approximation, not a real identity: the same
--     person browsing on two different days produces two different hashes
--     and is counted twice in a 30-day rollup. This is the same tradeoff
--     every cookieless/privacy-first analytics tool (Plausible, Fathom,
--     Simple Analytics) makes — there is no way to count returning visitors
--     across days without persistent tracking, and that's out of scope here
--     on purpose.
--   - `country` is the two-letter code Cloudflare already attaches to every
--     request (`request.cf.country`, read via Astro.locals.runtime.cf in
--     the Cloudflare adapter) — no geolocation lookup of our own, no third
--     party sees anything.
--   - Written only for real page navigations to the public site — see
--     src/middleware.ts for the exact exclusions (/admin, /api, non-GET,
--     non-200s).
create table public.page_views (
  id bigint generated always as identity primary key,
  path text not null,
  country text,
  visitor_hash text not null,
  viewed_at timestamptz not null default now()
);

create index page_views_viewed_at_idx on public.page_views (viewed_at);
create index page_views_visitor_hash_idx on public.page_views (visitor_hash);

alter table public.page_views enable row level security;

-- Insert has to be open to anonymous requests — a real visitor is never
-- signed in — but that's the ONLY thing this policy allows: no select,
-- update, or delete for anon, and no way to read back what you just wrote.
create policy "public insert page_views" on public.page_views for insert with check (true);

-- Admin-only read (same is_admin() backstop as every other admin-facing
-- table — see 0002_auth_admin.sql). This is genuinely the only way to
-- retrieve anything from this table at all: no other select policy exists.
create policy "admin read page_views" on public.page_views for select using (is_admin());

-- One aggregation RPC rather than several round trips from the admin
-- dashboard — computes every number that page needs in a single query.
-- `security invoker` (the default) is deliberate: it runs as whichever
-- role calls it, so the "admin read page_views" policy above is what
-- actually protects this data, not a separate check baked into the
-- function — same "RLS is the real gate" posture as every other table
-- here, rather than trusting application code alone.
--
-- Hour-of-day is bucketed in America/New_York (LEAGUE_TIME_ZONE in
-- src/lib/timezone.ts) rather than UTC, so "what times" reads the way
-- Logan actually experiences the clock, not shifted by several hours.
-- generate_series(0,23) guarantees all 24 hours are present (as 0 views)
-- even on a mostly-quiet slice, so the admin dashboard never has to paper
-- over gaps client-side.
create or replace function public.get_page_view_stats()
returns json
language sql
stable
as $$
  select json_build_object(
    'visitorsToday', (select count(distinct visitor_hash) from public.page_views where viewed_at >= date_trunc('day', now())),
    'viewsToday', (select count(*) from public.page_views where viewed_at >= date_trunc('day', now())),
    'visitors7d', (select count(distinct visitor_hash) from public.page_views where viewed_at >= now() - interval '7 days'),
    'views7d', (select count(*) from public.page_views where viewed_at >= now() - interval '7 days'),
    'visitors30d', (select count(distinct visitor_hash) from public.page_views where viewed_at >= now() - interval '30 days'),
    'views30d', (select count(*) from public.page_views where viewed_at >= now() - interval '30 days'),
    'topCountries', (
      select coalesce(json_agg(row_to_json(c)), '[]'::json) from (
        select coalesce(country, 'Unknown') as country, count(distinct visitor_hash) as visitors
        from public.page_views
        where viewed_at >= now() - interval '30 days'
        group by coalesce(country, 'Unknown')
        order by visitors desc, country asc
        limit 8
      ) c
    ),
    'hourly', (
      select json_agg(row_to_json(h) order by h.hour) from (
        select gs.hour, count(pv.id) as views
        from generate_series(0, 23) as gs(hour)
        left join public.page_views pv
          on extract(hour from pv.viewed_at at time zone 'America/New_York')::int = gs.hour
          and pv.viewed_at >= now() - interval '30 days'
        group by gs.hour
      ) h
    )
  );
$$;
