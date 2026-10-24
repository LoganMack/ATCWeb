-- Driver privacy timing (U4, NFR3.4): how much database time the masked views add to the three heaviest
-- public reads, measured as anon on production's data. A hand check for the owner, not run by CI.
--
-- Paste into the Supabase SQL editor (or run with psql against production with the owner's OK), after
-- 20261029120000_driver_privacy_views.sql is applied. It only reads, inside a transaction that is rolled
-- back. Each read runs 10 times through the views and 10 times on the base tables; the notices give the
-- medians in milliseconds. Pass: each view median is at most 20 ms above its base-table median. Paste the
-- notices into the PR 1 description.
--
-- The reads: the race results of the latest round with results (about 40 rows) joined to the drivers as
-- the results pages do, the news list, and the latest posted round's penalties.

begin;

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_round bigint;
  v_posted bigint;
  v_start timestamptz;
  v_view numeric[];
  v_base numeric[];
  v_dummy bigint;
  v_case text;
  i integer;
begin
  select max(subsession_id) into v_round from public.curated_race_results;
  select max(s.subsession_id) into v_posted from public.round_incident_status s where s.posted;

  foreach v_case in array array['round results', 'news list', 'round penalties'] loop
    v_view := '{}';
    v_base := '{}';
    for i in 1 .. 10 loop
      v_start := clock_timestamp();
      if v_case = 'round results' then
        select count(*) into v_dummy from public.curated_race_results_shown r
        left join public.drivers_shown d on d.iracing_cust_id = r.cust_id
        where r.subsession_id = v_round;
      elsif v_case = 'news list' then
        select count(*) into v_dummy from (select body, author_name from public.news_posts_shown order by published_at desc) t;
      else
        select count(*) into v_dummy from (select description, appeal_result from public.penalties_shown
                                           where subsession_id = v_posted) t;
      end if;
      v_view := v_view || (extract(epoch from clock_timestamp() - v_start) * 1000)::numeric;

      v_start := clock_timestamp();
      if v_case = 'round results' then
        select count(*) into v_dummy from public.curated_race_results r
        left join public.drivers d on d.iracing_cust_id = r.cust_id
        where r.subsession_id = v_round;
      elsif v_case = 'news list' then
        select count(*) into v_dummy from (select body, author_name from public.news_posts order by published_at desc) t;
      else
        select count(*) into v_dummy from (select description, appeal_result from public.penalties
                                           where subsession_id = v_posted) t;
      end if;
      v_base := v_base || (extract(epoch from clock_timestamp() - v_start) * 1000)::numeric;
    end loop;

    raise notice '%: views median % ms, base tables median % ms',
      v_case,
      round((select percentile_cont(0.5) within group (order by x) from unnest(v_view) x)::numeric, 2),
      round((select percentile_cont(0.5) within group (order by x) from unnest(v_base) x)::numeric, 2);
  end loop;
end $$;

rollback;
