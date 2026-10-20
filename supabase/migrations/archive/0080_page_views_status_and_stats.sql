-- Alpha Touring Challenge — page_views.status + popular pages / errors stats
--
-- Extends the analytics added in 0077_page_views.sql (admin dashboard "Site
-- Analytics" section) per Logan's request to also surface "Most Popular
-- Pages by Views" and "Most Common Errors triggered by users."
--
-- Up to now page_views only ever logged a genuine 200 page view (see
-- middleware.ts's logging condition). To track errors too, middleware.ts is
-- being changed to ALSO log non-200 responses (404s, 500s — never 3xx
-- redirects, which aren't a page a visitor "hit" so much as a bounce), so
-- every row now needs to record what status it actually was. Existing rows
-- predate this column and were all genuine 200 views by definition (the old
-- logging condition required it), so backfilling the default onto them is
-- exactly correct, not a guess.
--
-- Every EXISTING stat (visitorsToday/7d/30d, views*, topCountries, hourly)
-- gets a new `status = 200` filter added here so none of them silently
-- start counting error hits as if they were real traffic once errors begin
-- being logged alongside views.
alter table public.page_views add column status integer not null default 200;

-- Powers "Most Common Errors" (status >= 400) without a full-table scan once
-- error volume grows; topPages/topCountries/hourly/etc. stay fine on the
-- existing viewed_at index since they're always filtered by viewed_at first.
create index page_views_status_idx on public.page_views (status) where status >= 400;

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
    -- Most-visited paths, last 30 days, successful views only — an error
    -- page getting hit a lot belongs in topErrors below, not here.
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
    -- Grouped by path+status (not just path) — a 404 and a 500 on the same
    -- path are different problems worth telling apart.
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
