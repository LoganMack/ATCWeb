-- Alpha Touring Challenge — traffic-by-hour for TODAY, not just the 30-day rollup
--
-- The admin dashboard's "Traffic by Hour" chart only ever showed a 30-day
-- rollup (get_page_view_stats()'s `hourly` key, 0077_page_views.sql). Logan
-- wants a second chart right below it for just today, so a real-time traffic
-- shape (this morning's stream vs. this afternoon's, say) doesn't get
-- smoothed away by 30 days of averaging.
--
-- `hourlyToday` bucketed in America/New_York, same as `hourly` — "today"
-- here means today's calendar date in America/New_York (LEAGUE_TIME_ZONE),
-- so the two charts line up hour-for-hour. Note this is a different day
-- boundary than viewsToday/visitorsToday above (those use date_trunc('day',
-- now()), i.e. UTC midnight) — left as-is since those two aren't changing,
-- but worth knowing if the numbers ever look mismatched by a few hours
-- around ET midnight. Same generate_series(0,23) + left join shape as
-- `hourly` so every hour of today is present (as 0) even before it's begun.
create or replace function public.get_page_view_stats()
returns json
language sql
stable
as $$
  select json_build_object(
    'visitorsToday', (select count(distinct visitor_hash) from public.page_views where viewed_at >= date_trunc('day', now()) and status = 200),
    'viewsToday', (select count(*) from public.page_views where viewed_at >= date_trunc('day', now()) and status = 200),
    'visitors7d', (select count(distinct visitor_hash) from public.page_views where viewed_at >= now() - interval '7 days' and status = 200),
    'views7d', (select count(*) from public.page_views where viewed_at >= now() - interval '7 days' and status = 200),
    'visitors30d', (select count(distinct visitor_hash) from public.page_views where viewed_at >= now() - interval '30 days' and status = 200),
    'views30d', (select count(*) from public.page_views where viewed_at >= now() - interval '30 days' and status = 200),
    'topCountries', (
      select coalesce(json_agg(row_to_json(c)), '[]'::json) from (
        select coalesce(country, 'Unknown') as country, count(distinct visitor_hash) as visitors
        from public.page_views
        where viewed_at >= now() - interval '30 days' and status = 200
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
          and pv.status = 200
        group by gs.hour
      ) h
    ),
    'hourlyToday', (
      select json_agg(row_to_json(h) order by h.hour) from (
        select gs.hour, count(pv.id) as views
        from generate_series(0, 23) as gs(hour)
        left join public.page_views pv
          on extract(hour from pv.viewed_at at time zone 'America/New_York')::int = gs.hour
          and (pv.viewed_at at time zone 'America/New_York')::date = (now() at time zone 'America/New_York')::date
          and pv.status = 200
        group by gs.hour
      ) h
    ),
    'topPages', (
      select coalesce(json_agg(row_to_json(p)), '[]'::json) from (
        select path, count(*) as views
        from public.page_views
        where viewed_at >= now() - interval '30 days' and status = 200
        group by path
        order by views desc, path asc
        limit 8
      ) p
    ),
    'topErrors', (
      select coalesce(json_agg(row_to_json(e)), '[]'::json) from (
        select path, status, count(*) as occurrences
        from public.page_views
        where viewed_at >= now() - interval '30 days' and status >= 400
        group by path, status
        order by occurrences desc, path asc
        limit 8
      ) e
    )
  );
$$;
