-- 0103_page_view_stats_performance.sql
-- Makes get_page_view_stats() (the admin dashboard's Site Analytics) fast enough to finish inside
-- Supabase's 8s statement timeout for the authenticated role. It had been hitting that timeout on
-- every call (measured ~8.4s end to end), so the dashboard never showed analytics at all. Also lets the
-- caller pick the reporting window (30 days / 90 days / 1 year / all time) instead of a fixed 30 days.
--
-- Called with no arguments it returns the same keys and the same numbers as before
-- (0083_page_views_hourly_today.sql), plus three new keys, so a caller that predates this keeps working.

-- 1. The "admin read page_views" policy called is_admin() bare, so Postgres re-evaluated it for every
--    row it read, and each evaluation is its own profiles lookup. Wrapped in (select ...) it becomes an
--    initplan: evaluated once per statement and reused for every row. Same rule, same protection —
--    non-admins still read nothing. Same fix 00724 applied to auth.uid(); the Supabase advisor only
--    flags auth.uid(), which is how this one was missed.
drop policy if exists "admin read page_views" on public.page_views;
create policy "admin read page_views" on public.page_views for select using ((select public.is_admin()));

-- 2. The function ran ~10 independent subqueries against page_views, each its own scan (and each paying
--    cause 1 per row). Now the reporting window is read once into a materialized CTE, and every stat is
--    computed from that.
--
-- 3. hourlyToday filtered with `(viewed_at at time zone 'America/New_York')::date = <today ET>`, which no
--    index can serve, inside a left join against generate_series — a scan of the ENTIRE table, all
--    history, potentially once per hour bucket. It now uses a plain lower bound on viewed_at (midnight
--    today in America/New_York, as a timestamptz), which always falls inside the window.
--    Equivalent: viewed_at defaults to now(), so no row is ever dated after today.
--
-- 4. p_days picks the window for the window-scoped stats: visitorsRange/viewsRange, topCountries,
--    hourly, topPages, topErrors. Null means all time. Values under 30 are raised to 30, so the window
--    always covers the fixed-length stats (today, 7 days, and visitors30d/views30d, kept for callers
--    that predate this). Default 30 = exactly the old behaviour. The lower bound is a CASE yielding
--    '-infinity' for all time, rather than `p_days is null or ...`, so it stays a plain range the
--    viewed_at index can serve. (Not coalesce(now() - greatest(p_days, 30) ...): greatest() ignores
--    NULLs, so greatest(null, 30) is 30 and "all time" would silently become 30 days.)
--
-- The signature changes (new argument), and CREATE OR REPLACE can't change a signature, so the old
-- zero-argument function is dropped first. PostgREST resolves a `{}` body to this one via the default.
-- Dropping loses its grants and 0097_security_hardening.sql's search_path pin, so both are set again
-- here. Execute goes to authenticated only (the dashboard calls it with the admin's own token; anon
-- would only ever get zeros back from RLS anyway).
drop function if exists public.get_page_view_stats();

create or replace function public.get_page_view_stats(p_days integer default 30)
returns json
language sql
stable
set search_path = public
as $$
  with recent as materialized (
    select viewed_at, status, path, country, visitor_hash
    from public.page_views
    where viewed_at >= case
      when p_days is null then '-infinity'::timestamptz
      else now() - make_interval(days => greatest(p_days, 30))
    end
  ),
  ok as (
    select * from recent where status = 200
  ),
  bounds as (
    select
      date_trunc('day', now()) as today_start,
      (date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York') as today_start_et
  ),
  hourly_counts as (
    select extract(hour from viewed_at at time zone 'America/New_York')::int as hour, count(*) as views
    from ok
    group by 1
  ),
  hourly_today_counts as (
    select extract(hour from ok.viewed_at at time zone 'America/New_York')::int as hour, count(*) as views
    from ok, bounds
    where ok.viewed_at >= bounds.today_start_et
    group by 1
  )
  select json_build_object(
    'rangeDays', case when p_days is null then null else greatest(p_days, 30) end,
    'visitorsToday', (select count(distinct visitor_hash) from ok, bounds where viewed_at >= bounds.today_start),
    'viewsToday', (select count(*) from ok, bounds where viewed_at >= bounds.today_start),
    'visitors7d', (select count(distinct visitor_hash) from ok where viewed_at >= now() - interval '7 days'),
    'views7d', (select count(*) from ok where viewed_at >= now() - interval '7 days'),
    'visitors30d', (select count(distinct visitor_hash) from ok where viewed_at >= now() - interval '30 days'),
    'views30d', (select count(*) from ok where viewed_at >= now() - interval '30 days'),
    'visitorsRange', (select count(distinct visitor_hash) from ok),
    'viewsRange', (select count(*) from ok),
    'topCountries', (
      select coalesce(json_agg(row_to_json(c)), '[]'::json) from (
        select coalesce(country, 'Unknown') as country, count(distinct visitor_hash) as visitors
        from ok
        group by coalesce(country, 'Unknown')
        order by visitors desc, country asc
        limit 8
      ) c
    ),
    'hourly', (
      select json_agg(row_to_json(h) order by h.hour) from (
        select gs.hour, coalesce(hc.views, 0) as views
        from generate_series(0, 23) as gs(hour)
        left join hourly_counts hc on hc.hour = gs.hour
      ) h
    ),
    'hourlyToday', (
      select json_agg(row_to_json(h) order by h.hour) from (
        select gs.hour, coalesce(hc.views, 0) as views
        from generate_series(0, 23) as gs(hour)
        left join hourly_today_counts hc on hc.hour = gs.hour
      ) h
    ),
    'topPages', (
      select coalesce(json_agg(row_to_json(p)), '[]'::json) from (
        select path, count(*) as views
        from ok
        group by path
        order by views desc, path asc
        limit 8
      ) p
    ),
    'topErrors', (
      select coalesce(json_agg(row_to_json(e)), '[]'::json) from (
        select path, status, count(*) as occurrences
        from recent
        where status >= 400
        group by path, status
        order by occurrences desc, path asc
        limit 8
      ) e
    )
  );
$$;

revoke all on function public.get_page_view_stats(integer) from public, anon;
grant execute on function public.get_page_view_stats(integer) to authenticated, service_role;
