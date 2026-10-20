-- Baseline, part 1 of 2: the site's own schemas (`public` and `private`).
--
-- What: production's schema, dumped with `supabase db dump` (schema only, no data) on
-- 2026-10-20, after 0116_security_fixes_followup was applied. Below this header the dump is
-- unchanged. Part 2, 20261020120001_baseline_platform.sql, adds what the site puts into
-- Supabase's own schemas (storage buckets and policies, the auth.users sign-up trigger).
--
-- Why: the old numbered migrations (now in supabase/migrations/archive/) could not rebuild
-- production: some were applied by hand, two shared a number, and several were data fixes.
-- These two files are the starting point instead. A fresh database (CI, `supabase db reset`)
-- is built from them plus any newer timestamped migration, and production's migration history
-- lists exactly these two versions after the history cutover (supabase/tools/history-cutover.sql).
--
-- Never edit this file. Change the schema with a new timestamped migration and its down script.



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "private";


ALTER SCHEMA "private" OWNER TO "postgres";


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "private"."has_reviewed_incident_report"("p_report_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from incident_report_reviews
    where report_id = p_report_id and reviewer_id = auth.uid()
  );
$$;


ALTER FUNCTION "private"."has_reviewed_incident_report"("p_report_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$;


ALTER FUNCTION "private"."is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."is_involved_in_incident_report"("p_report_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from incident_report_drivers ird
    join profiles p on p.driver_id = ird.driver_id
    where ird.report_id = p_report_id and p.id = auth.uid()
  );
$$;


ALTER FUNCTION "private"."is_involved_in_incident_report"("p_report_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ack_signup_rejections"("p_request_ids" "uuid"[]) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_count integer;
begin
  update public.signup_requests
  set notified_at = now()
  where id = any (p_request_ids) and status = 'rejected' and notified_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


ALTER FUNCTION "public"."ack_signup_rejections"("p_request_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_delete_user"("p_user_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete users' using errcode = 'insufficient_privilege';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'You cannot delete your own account' using errcode = 'invalid_parameter_value';
  end if;
  update public.incident_reports set reporter_id = null where reporter_id = p_user_id;
  delete from auth.users where id = p_user_id;
  if not found then
    raise exception 'No such user' using errcode = 'no_data_found';
  end if;
end;
$$;


ALTER FUNCTION "public"."admin_delete_user"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_list_user_emails"() RETURNS TABLE("id" "uuid", "email" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can list user emails' using errcode = 'insufficient_privilege';
  end if;
  return query select u.id, u.email::text from auth.users u;
end;
$$;


ALTER FUNCTION "public"."admin_list_user_emails"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."approve_signup_request"("p_request_id" "uuid", "p_name" "text", "p_iracing_cust_id" bigint, "p_class_id" integer, "p_driver_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_request public.signup_requests%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_driver_id uuid := p_driver_id;
  v_current_number integer;
  v_number integer;
  v_n integer;
  v_has_raced boolean;
  v_status_id integer;
  v_current_status text;
  v_existing_cust_id bigint;
  v_driver_name text;
begin
  if not is_admin() then
    raise exception 'Only an admin can approve sign-ups' using errcode = 'insufficient_privilege';
  end if;

  select * into v_request from public.signup_requests where id = p_request_id for update;
  if not found then
    raise exception 'Sign-up request not found';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'This sign-up has already been %', v_request.status;
  end if;
  if p_class_id is null or not exists (select 1 from public.driver_classes where id = p_class_id) then
    raise exception 'Pick a class';
  end if;
  -- Friendly versions of the drivers table's unique constraints.
  if p_iracing_cust_id is not null and exists (
    select 1 from public.drivers
    where iracing_cust_id = p_iracing_cust_id and (v_driver_id is null or id <> v_driver_id)
  ) then
    raise exception 'iRacing ID % already belongs to % — approve it as that returning driver instead',
      p_iracing_cust_id, (select name from public.drivers where iracing_cust_id = p_iracing_cust_id);
  end if;
  if v_driver_id is null and exists (select 1 from public.drivers where lower(name) = lower(v_name)) then
    raise exception 'A driver named % is already on the roster — approve it as that returning driver, or change the name',
      (select name from public.drivers where lower(name) = lower(v_name) limit 1);
  end if;

  if v_driver_id is not null then
    -- Returning driver: keep their number if they still hold one.
    select car_number into v_current_number from public.drivers where id = v_driver_id for update;
    if not found then
      raise exception 'The selected roster driver no longer exists';
    end if;
  end if;

  if v_current_number is not null then
    v_number := v_current_number;
  else
    foreach v_n in array v_request.requested_numbers loop
      if public.car_number_holder(v_n, v_driver_id) is null then
        v_number := v_n;
        exit;
      end if;
    end loop;
    if v_number is null then
      raise exception 'None of the requested numbers (%) is free any more — reject this sign-up instead',
        array_to_string(v_request.requested_numbers, ', ');
    end if;
  end if;

  if v_driver_id is null then
    if length(v_name) = 0 then
      raise exception 'A driver name is required';
    end if;
    select id into v_status_id from public.driver_statuses where name = 'New';
    insert into public.drivers (name, class_id, status_id, is_rookie, iracing_cust_id, sign_up_date, last_signed_up_at)
    values (v_name, p_class_id, v_status_id, true, p_iracing_cust_id, current_date, now())
    returning id into v_driver_id;
  else
    -- Never silently replace an iRacing ID: it's what links the driver to
    -- their results.
    select iracing_cust_id, name into v_existing_cust_id, v_driver_name from public.drivers where id = v_driver_id;
    if p_iracing_cust_id is not null and v_existing_cust_id is not null and p_iracing_cust_id <> v_existing_cust_id then
      raise exception '% already has iRacing ID %, but this sign-up says % — check which is right, and clear the iRacing ID field to keep theirs',
        v_driver_name, v_existing_cust_id, p_iracing_cust_id;
    end if;

    -- Veterans stay Veteran (they're exempt from inactivity). Anyone else goes
    -- back to Active if they've raced before, New if they never have — the
    -- same split sync_driver_statuses() uses.
    select ds.name into v_current_status
    from public.drivers d join public.driver_statuses ds on ds.id = d.status_id
    where d.id = v_driver_id;
    if v_current_status = 'Veteran' then
      select status_id into v_status_id from public.drivers where id = v_driver_id;
    else
      select lr.last_race_at is not null into v_has_raced
      from public.driver_last_race lr where lr.driver_id = v_driver_id;
      select id into v_status_id from public.driver_statuses
      where name = case when coalesce(v_has_raced, false) then 'Active' else 'New' end;
    end if;

    update public.drivers
    set status_id = v_status_id,
        class_id = p_class_id,
        iracing_cust_id = coalesce(iracing_cust_id, p_iracing_cust_id),
        last_signed_up_at = now()
    where id = v_driver_id;
  end if;

  if v_current_number is null then
    -- Logan's number rule, including freeing it from an Inactive holder.
    perform public.set_driver_car_number(v_driver_id, v_number);
  end if;

  update public.signup_requests
  set status = 'approved',
      driver_id = v_driver_id,
      decided_by = auth.uid(),
      decided_at = now()
  where id = p_request_id;

  -- The roster name, which for a returning driver can differ from the sign-up's.
  select name into v_driver_name from public.drivers where id = v_driver_id;
  return jsonb_build_object('driver_id', v_driver_id, 'driver_name', v_driver_name, 'car_number', v_number);
end;
$$;


ALTER FUNCTION "public"."approve_signup_request"("p_request_id" "uuid", "p_name" "text", "p_iracing_cust_id" bigint, "p_class_id" integer, "p_driver_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_upload_incident_appeal_file"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select auth.uid() is not null
    and (
      select count(*) from storage.objects o
      where o.bucket_id = 'incident-appeals'
        and o.name like auth.uid()::text || '/%'
        and o.created_at > now() - interval '1 day'
    ) < 15;
$$;


ALTER FUNCTION "public"."can_upload_incident_appeal_file"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."car_number_holder"("p_number" integer, "p_exclude_driver_id" "uuid" DEFAULT NULL::"uuid") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select d.name
  from public.drivers d
  join public.driver_statuses ds on ds.id = d.status_id
  where d.car_number = p_number
    and ds.name <> 'Inactive'
    and (p_exclude_driver_id is null or d.id <> p_exclude_driver_id)
  limit 1;
$$;


ALTER FUNCTION "public"."car_number_holder"("p_number" integer, "p_exclude_driver_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."clear_incident_report_dismissal_reason"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if new.status is distinct from 'dismissed' then
    new.dismissal_reason := null;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."clear_incident_report_dismissal_reason"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_team_roster_limits"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if (select count(*) from team_rosters where season_id = new.season_id and team_id = new.team_id) >= 4 then
    raise exception 'A team roster can have at most 4 drivers in a season.';
  end if;
  if exists (
    select 1 from team_rosters
    where season_id = new.season_id and driver_id = new.driver_id and team_id <> new.team_id
  ) then
    raise exception 'This driver is already on another team''s roster for this season.';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."enforce_team_roster_limits"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_missing_race_results_count"() RETURNS integer
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select count(*)::int from public.events e
  where e.category = 'championship'
    and e.event_date < current_date
    and not exists (
      select 1 from public.curated_rounds cr
      join public.curated_race_results crr on crr.subsession_id = cr.subsession_id
      where cr.event_id = e.id
    );
$$;


ALTER FUNCTION "public"."get_missing_race_results_count"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_news_post_view_counts"() RETURNS json
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select coalesce(json_agg(row_to_json(v)), '[]'::json) from (
    select path, count(distinct visitor_hash) as views
    from public.page_views
    where path like '/news/_%' and status = 200
    group by path
  ) v
$$;


ALTER FUNCTION "public"."get_news_post_view_counts"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_page_view_stats"("p_days" integer DEFAULT 30) RETURNS json
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."get_page_view_stats"("p_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name');

  insert into public.activity_log (actor_id, actor_name, action, entity_type, entity_label, entity_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', new.email, 'Unknown'),
    'add',
    'user',
    coalesce(new.raw_user_meta_data ->> 'display_name', new.email, 'Unknown'),
    new.id::text
  );

  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_reviewed_incident_report"("p_report_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$ select private.has_reviewed_incident_report(p_report_id); $$;


ALTER FUNCTION "public"."has_reviewed_incident_report"("p_report_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_submitted_race_interview"("p_subsession_id" bigint) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from race_interviews i
    join profiles p on p.driver_id = i.driver_id
    where p.id = auth.uid() and i.subsession_id = p_subsession_id
  );
$$;


ALTER FUNCTION "public"."has_submitted_race_interview"("p_subsession_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."incident_report_review_counts"("p_subsession_id" bigint) RETURNS TABLE("report_id" "uuid", "review_count" integer)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if not public.is_admin() then
    raise exception 'admins only';
  end if;
  return query
    select v.report_id, count(*)::integer
    from incident_report_reviews v
    join incident_reports r on r.id = v.report_id
    where r.subsession_id = p_subsession_id
    group by v.report_id;
end;
$$;


ALTER FUNCTION "public"."incident_report_review_counts"("p_subsession_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$ select private.is_admin(); $$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_involved_in_incident_report"("p_report_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$ select private.is_involved_in_incident_report(p_report_id); $$;


ALTER FUNCTION "public"."is_involved_in_incident_report"("p_report_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_race_interview_path_submitted"("p_name" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (select 1 from public.race_interviews where audio_path = p_name);
$$;


ALTER FUNCTION "public"."is_race_interview_path_submitted"("p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pending_signup_rejections"() RETURNS TABLE("request_id" "uuid", "discord_user_id" "text", "name" "text", "reason" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select id, discord_user_id, name, reason
  from public.signup_requests
  where status = 'rejected' and notified_at is null
  order by decided_at;
$$;


ALTER FUNCTION "public"."pending_signup_rejections"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_role_self_escalation"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if not public.is_admin() then
    if new.role is distinct from old.role then
      raise exception 'Only an admin can change a profile role'
        using errcode = 'insufficient_privilege';
    end if;
    if new.driver_id is distinct from old.driver_id
       or new.iracing_cust_id is distinct from old.iracing_cust_id
       or new.iracing_name is distinct from old.iracing_name then
      raise exception 'Only an admin can link a profile to a driver or iRacing account'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."prevent_role_self_escalation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."recalculate_race_scores"("p_subsession_id" bigint) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_round      record;
  v_rules      jsonb;
  v_ruleset_id uuid;
  v_written    int;
  v_override_active boolean;
  v_gamma_enabled boolean;
  v_delta_enabled boolean;
  v_fallback_class_id integer;
  v_sublime_finesse_enabled boolean;
  v_class_pole_enabled boolean;
  v_naked_aggression_enabled boolean;
  v_lap_led_enabled boolean;
  v_fewest_incidents_enabled boolean;
  v_fewest_incidents_top_x integer;
  v_fewest_incidents_per text;
  v_fastest_lap_enabled boolean;
  v_fastest_lap_top_x integer;
  v_fastest_lap_per text;
  v_sprint_sweep_enabled boolean;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an admin can recalculate scores'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_round from public.curated_rounds where subsession_id = p_subsession_id;
  if not found then
    raise exception 'No such round: %', p_subsession_id;
  end if;

  if v_round.season_id is not null then
    perform pg_advisory_xact_lock(hashtext(v_round.season_id::text));
  end if;

  if exists (select 1 from public.seasons
             where id = v_round.season_id and standings_locked_at is not null) then
    raise exception 'Season standings are locked; unlock the season to rescore'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  delete from public.race_scores where subsession_id = p_subsession_id;

  if v_round.season_id is null then
    raise exception 'Round % is not linked to a season', p_subsession_id;
  end if;
  if v_round.format is null then
    raise exception 'Round % has no format; scoring cannot pick a points table',
      p_subsession_id;
  end if;

  select s.scoring_ruleset_id, r.rules, s.gamma_enabled, s.delta_enabled
  into v_ruleset_id, v_rules, v_gamma_enabled, v_delta_enabled
  from public.seasons s
  join public.scoring_rulesets r on r.id = s.scoring_ruleset_id
  where s.id = v_round.season_id;

  if v_rules is null then
    raise exception 'Season % has no scoring ruleset', v_round.season_id;
  end if;

  if v_rules->'base_points'->v_round.format is null then
    raise exception 'Ruleset % has no base_points for format %', v_ruleset_id, v_round.format;
  end if;
  if v_rules->'classified_minimum'->>v_round.format is null then
    raise exception 'Ruleset % has no classified_minimum for format %', v_ruleset_id, v_round.format;
  end if;

  select exists (
    select 1
    from jsonb_array_elements_text(coalesce(v_rules->'race_overrides'->'subsession_ids', '[]'::jsonb)) sid
    where sid = p_subsession_id::text
  ) into v_override_active;

  v_sublime_finesse_enabled := coalesce((v_rules->'bonuses'->'sublime_finesse'->>'enabled')::boolean, false);
  v_class_pole_enabled := coalesce((v_rules->'bonuses'->'class_pole'->>'enabled')::boolean, false);
  v_naked_aggression_enabled := coalesce((v_rules->'bonuses'->'naked_aggression'->>'enabled')::boolean, false);
  v_lap_led_enabled := coalesce((v_rules->'bonuses'->'lap_led'->>'enabled')::boolean, false);
  v_fewest_incidents_enabled := coalesce((v_rules->'bonuses'->'fewest_incidents'->>'enabled')::boolean, false);
  v_fewest_incidents_top_x := coalesce((v_rules->'bonuses'->'fewest_incidents'->>'top_x')::integer, 0);
  v_fewest_incidents_per := coalesce(v_rules->'bonuses'->'fewest_incidents'->>'per', 'race');
  v_fastest_lap_enabled := coalesce((v_rules->'bonuses'->'fastest_lap'->>'enabled')::boolean, false);
  v_fastest_lap_top_x := coalesce((v_rules->'bonuses'->'fastest_lap'->>'top_x')::integer, 0);
  v_fastest_lap_per := coalesce(v_rules->'bonuses'->'fastest_lap'->>'per', 'race');
  v_sprint_sweep_enabled := coalesce((v_rules->'bonuses'->'sprint_sweep'->>'enabled')::boolean, false);

  select dc.id into v_fallback_class_id
  from public.driver_classes dc
  where dc.name = 'Alpha'
     or (dc.name = 'Gamma' and v_gamma_enabled)
     or (dc.name = 'Delta' and v_delta_enabled)
  order by dc.sort_order
  limit 1;

  with
  entrant as (
    select
      rr.race_number,
      rr.cust_id,
      d.id        as driver_id,
      ec.class_id as class_id,
      tr.team_id as team_id,
      d.name      as driver_name,
      dc.name     as class_name,
      coalesce(rr.adjusted_position, rr.finish_position) as position,
      rr.starting_position,
      rr.laps_complete,
      rr.laps_led,
      rr.best_lap_ten_thousandths,
      rr.incidents
    from public.curated_race_results rr
    join public.drivers d        on d.iracing_cust_id = rr.cust_id
    left join public.driver_season_classes dsc
      on dsc.driver_id = d.id and dsc.season_id = v_round.season_id
    left join public.team_rosters tr
      on tr.driver_id = d.id and tr.season_id = v_round.season_id
    join public.driver_classes dcur on dcur.id = d.class_id
    cross join lateral (
      select coalesce(
        dsc.class_id,
        case
          when dcur.name = 'Gamma' and not v_gamma_enabled then v_fallback_class_id
          when dcur.name = 'Delta' and not v_delta_enabled then v_fallback_class_id
          else d.class_id
        end
      ) as class_id
    ) ec
    join public.driver_classes dc on dc.id = ec.class_id
    where rr.subsession_id = p_subsession_id
  ),
  qual_entrant as (
    select
      cq.cust_id,
      coalesce(
        dsc.class_id,
        case
          when dcur.name = 'Gamma' and not v_gamma_enabled then v_fallback_class_id
          when dcur.name = 'Delta' and not v_delta_enabled then v_fallback_class_id
          else d.class_id
        end
      ) as class_id
    from public.curated_qualifying cq
    join public.drivers d on d.iracing_cust_id = cq.cust_id
    left join public.driver_season_classes dsc
      on dsc.driver_id = d.id and dsc.season_id = v_round.season_id
    join public.driver_classes dcur on dcur.id = d.class_id
    where cq.subsession_id = p_subsession_id
  ),
  distance as (
    select race_number, max(laps_complete) as leader_laps
    from public.curated_race_results
    where subsession_id = p_subsession_id
    group by race_number
  ),
  dsqd as (
    select distinct cust_id
    from public.curated_race_results
    where subsession_id = p_subsession_id
      and reason_out in ('Disqualified', 'DQ/Scoring Invalidated')
  ),
  deduction as (
    select
      p.race_number,
      d.iracing_cust_id as cust_id,
      sum(case when p.is_appealed then p.appeal_points_penalty else p.points_penalty end) as points_deduction
    from public.penalties p
    join public.drivers d on d.id = p.driver_id
    where p.subsession_id = p_subsession_id
    group by p.race_number, d.iracing_cust_id
  ),
  classified as (
    select
      e.*,
      (d.leader_laps > 0
        and coalesce(e.laps_complete, 0) >= d.leader_laps * 0.5) as is_classified
    from entrant e
    join distance d using (race_number)
  ),
  class_rank as (
    select
      c.race_number, c.cust_id,
      (row_number() over (
        partition by c.race_number, c.class_id
        order by c.position
      ))::int as class_position
    from classified c
    where c.is_classified
  ),
  pole as (
    select q.cust_id
    from (
      select
        cq.cust_id,
        row_number() over (partition by qe.class_id order by cq.qual_position) as rn
      from public.curated_qualifying cq
      join qual_entrant qe on qe.cust_id = cq.cust_id
      where cq.subsession_id = p_subsession_id
    ) q
    where q.rn = 1
  ),
  net_gain as (
    select
      c.race_number,
      c.cust_id,
      (c.starting_position - c.position) as gain
    from classified c
    where c.is_classified
      and c.starting_position is not null
      and c.cust_id not in (select cust_id from dsqd)
  ),
  best_gain_per_race as (
    select race_number, max(gain) as best_gain
    from net_gain
    group by race_number
  ),
  aggression as (
    select ng.race_number, ng.cust_id
    from net_gain ng
    join best_gain_per_race b
      on b.race_number = ng.race_number and b.best_gain = ng.gain
    where b.best_gain > 0
  ),
  lap_led_race as (
    select c.race_number, c.cust_id
    from classified c
    where c.is_classified
      and c.cust_id not in (select cust_id from dsqd)
      and coalesce(c.laps_led, 0) > 0
  ),
  incident_eligible_race as (
    select c.race_number, c.cust_id, c.incidents
    from classified c
    where c.is_classified
      and c.cust_id not in (select cust_id from dsqd)
      and v_fewest_incidents_top_x > 0
      and c.position <= v_fewest_incidents_top_x
  ),
  incident_min_race as (
    select race_number, min(incidents) as min_incidents
    from incident_eligible_race
    group by race_number
  ),
  fewest_incidents_race as (
    select e.race_number, e.cust_id
    from incident_eligible_race e
    join incident_min_race m on m.race_number = e.race_number and m.min_incidents = e.incidents
  ),
  lap_eligible_race as (
    select c.race_number, c.cust_id, c.best_lap_ten_thousandths
    from classified c
    where c.is_classified
      and c.cust_id not in (select cust_id from dsqd)
      and c.best_lap_ten_thousandths is not null
      and v_fastest_lap_top_x > 0
      and c.position <= v_fastest_lap_top_x
  ),
  lap_min_race as (
    select race_number, min(best_lap_ten_thousandths) as min_lap
    from lap_eligible_race
    group by race_number
  ),
  fastest_lap_race as (
    select e.race_number, e.cust_id
    from lap_eligible_race e
    join lap_min_race m on m.race_number = e.race_number and m.min_lap = e.best_lap_ten_thousandths
  ),
  round_stats as (
    select
      c.cust_id,
      min(c.position) as round_best_position,
      sum(c.incidents) as round_incidents,
      min(c.best_lap_ten_thousandths) as round_best_lap
    from classified c
    where c.is_classified
      and c.cust_id not in (select cust_id from dsqd)
    group by c.cust_id
  ),
  incident_eligible_round as (
    select cust_id, round_incidents
    from round_stats
    where v_fewest_incidents_top_x > 0
      and round_best_position <= v_fewest_incidents_top_x
  ),
  fewest_incidents_round as (
    select e.cust_id
    from incident_eligible_round e
    where e.round_incidents = (select min(round_incidents) from incident_eligible_round)
  ),
  lap_eligible_round as (
    select cust_id, round_best_lap
    from round_stats
    where v_fastest_lap_top_x > 0
      and round_best_position <= v_fastest_lap_top_x
      and round_best_lap is not null
  ),
  fastest_lap_round as (
    select e.cust_id
    from lap_eligible_round e
    where e.round_best_lap = (select min(round_best_lap) from lap_eligible_round)
  ),
  round_race_count as (
    select count(distinct race_number) as race_count from classified
  ),
  sprint_wins as (
    select c.cust_id, count(*) as win_count
    from classified c
    where c.is_classified and c.position = 1
      and c.cust_id not in (select cust_id from dsqd)
    group by c.cust_id
  ),
  sprint_sweep_winners as (
    select sw.cust_id
    from sprint_wins sw, round_race_count rc
    where v_round.format = 'sprint' and rc.race_count > 1 and sw.win_count = rc.race_count
  ),
  scored as (
    select
      c.race_number,
      c.driver_id,
      c.class_id,
      c.team_id,
      c.position,
      c.is_classified,
      (c.cust_id in (select cust_id from dsqd)) as is_dsq,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not c.is_classified then 0
        when c.position <= 40 then
          coalesce((
            case
              when v_override_active
                   and (v_rules->'race_overrides'->'base_points' ? c.race_number::text)
                then v_rules->'race_overrides'->'base_points'->c.race_number::text->>(c.position - 1)
              when v_round.format = 'sprint' and c.race_number = 3
                   and (v_rules->'base_points' ? 'sprint_race3')
                then v_rules->'base_points'->'sprint_race3'->>(c.position - 1)
              when v_round.format = 'sprint' and c.race_number > 1
                   and (v_rules->'base_points' ? 'sprint_race2')
                then v_rules->'base_points'->'sprint_race2'->>(c.position - 1)
              else v_rules->'base_points'->v_round.format->>(c.position - 1)
            end
          )::int, 0)
        else
          coalesce((
            case
              when v_override_active
                   and (v_rules->'race_overrides'->'classified_minimum' ? c.race_number::text)
                then v_rules->'race_overrides'->'classified_minimum'->>c.race_number::text
              else v_rules->'classified_minimum'->>v_round.format
            end
          )::int, 0)
      end as finish_points,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not c.is_classified then 0
        when not (coalesce(v_rules->'class_podium'->'applies_to', '[]'::jsonb) ? c.class_name) then 0
        when cr.class_position is null or cr.class_position > 3 then 0
        else coalesce((
          case
            when v_round.format = 'sprint' and c.race_number = 3
                 and (v_rules->'class_podium' ? 'sprint_race3')
              then v_rules->'class_podium'->'sprint_race3'->>(cr.class_position - 1)
            when v_round.format = 'sprint' and c.race_number > 1
                 and (v_rules->'class_podium' ? 'sprint_race2')
              then v_rules->'class_podium'->'sprint_race2'->>(cr.class_position - 1)
            else v_rules->'class_podium'->v_round.format->>(cr.class_position - 1)
          end
        )::int, 0)
      end as class_points,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not c.is_classified then 0
        when not v_sublime_finesse_enabled then 0
        when coalesce(c.incidents, 0)
             <= coalesce((v_rules->'bonuses'->'sublime_finesse'->>'max_incidents')::int, 0)
          then coalesce((v_rules->'bonuses'->'sublime_finesse'->>v_round.format)::int, 0)
        else 0
      end as finesse_bonus,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not v_class_pole_enabled then 0
        when c.race_number = 1 and c.cust_id in (select cust_id from pole)
          then coalesce((v_rules->'bonuses'->'class_pole'->>v_round.format)::int, 0)
        else 0
      end as pole_bonus,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not c.is_classified then 0
        when not v_naked_aggression_enabled then 0
        when exists (
          select 1 from aggression a
          where a.race_number = c.race_number and a.cust_id = c.cust_id
        ) then coalesce((v_rules->'bonuses'->'naked_aggression'->>v_round.format)::int, 0)
        else 0
      end as aggression_bonus,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not c.is_classified then 0
        when not v_lap_led_enabled then 0
        when exists (
          select 1 from lap_led_race l
          where l.race_number = c.race_number and l.cust_id = c.cust_id
        ) then coalesce((v_rules->'bonuses'->'lap_led'->>v_round.format)::int, 0)
        else 0
      end as lap_led_bonus,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not c.is_classified then 0
        when not v_fewest_incidents_enabled then 0
        when v_fewest_incidents_per = 'round' then
          case when c.race_number = 1 and c.cust_id in (select cust_id from fewest_incidents_round)
            then coalesce((v_rules->'bonuses'->'fewest_incidents'->>v_round.format)::int, 0)
            else 0 end
        when exists (
          select 1 from fewest_incidents_race f
          where f.race_number = c.race_number and f.cust_id = c.cust_id
        ) then coalesce((v_rules->'bonuses'->'fewest_incidents'->>v_round.format)::int, 0)
        else 0
      end as fewest_incidents_bonus,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not c.is_classified then 0
        when not v_fastest_lap_enabled then 0
        when v_fastest_lap_per = 'round' then
          case when c.race_number = 1 and c.cust_id in (select cust_id from fastest_lap_round)
            then coalesce((v_rules->'bonuses'->'fastest_lap'->>v_round.format)::int, 0)
            else 0 end
        when exists (
          select 1 from fastest_lap_race f
          where f.race_number = c.race_number and f.cust_id = c.cust_id
        ) then coalesce((v_rules->'bonuses'->'fastest_lap'->>v_round.format)::int, 0)
        else 0
      end as fastest_lap_bonus,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        when not v_sprint_sweep_enabled then 0
        when c.race_number = 1 and c.cust_id in (select cust_id from sprint_sweep_winners)
          then coalesce((v_rules->'bonuses'->'sprint_sweep'->>'points')::int, 0)
        else 0
      end as sprint_sweep_bonus,
      case
        when c.cust_id in (select cust_id from dsqd) then 0
        else coalesce(dd.points_deduction, 0)
      end as points_deduction
    from classified c
    left join class_rank cr using (race_number, cust_id)
    left join deduction dd using (race_number, cust_id)
  )
  insert into public.race_scores (
    subsession_id, race_number, driver_id, season_id, class_id, team_id,
    finish_points, class_points, finesse_bonus, pole_bonus, aggression_bonus,
    lap_led_bonus, fewest_incidents_bonus, fastest_lap_bonus, sprint_sweep_bonus,
    points_deduction,
    scored_position, classified, dsq, source
  )
  select
    p_subsession_id, s.race_number, s.driver_id, v_round.season_id, s.class_id, s.team_id,
    s.finish_points, s.class_points, s.finesse_bonus, s.pole_bonus, s.aggression_bonus,
    s.lap_led_bonus, s.fewest_incidents_bonus, s.fastest_lap_bonus, s.sprint_sweep_bonus,
    s.points_deduction,
    s.position, s.is_classified, s.is_dsq, 'computed'
  from scored s;

  get diagnostics v_written = row_count;
  return v_written;
end;
$$;


ALTER FUNCTION "public"."recalculate_race_scores"("p_subsession_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."recalculate_season_scores"("p_season_id" "uuid") RETURNS TABLE("subsession_id" bigint, "rows_written" integer, "error_message" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_subsession_id bigint;
  v_written int;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an admin can recalculate scores'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.seasons where id = p_season_id) then
    raise exception 'No such season: %', p_season_id;
  end if;

  for v_subsession_id in
    select cr.subsession_id
    from public.curated_rounds cr
    where cr.season_id = p_season_id
    order by cr.round_number nulls last, cr.start_time
  loop
    begin
      v_written := public.recalculate_race_scores(v_subsession_id);
      subsession_id := v_subsession_id;
      rows_written := v_written;
      error_message := null;
      return next;
    exception when others then
      subsession_id := v_subsession_id;
      rows_written := null;
      error_message := sqlerrm;
      return next;
    end;
  end loop;
  return;
end;
$$;


ALTER FUNCTION "public"."recalculate_season_scores"("p_season_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_page_view"("p_path" "text", "p_visitor_hash" "text", "p_country" "text", "p_status" integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  -- Same checks the 0097 insert policy applied.
  if p_path is null or char_length(p_path) not between 1 and 300 then raise exception 'invalid path'; end if;
  if p_visitor_hash is null or char_length(p_visitor_hash) not between 1 and 64 then raise exception 'invalid visitor'; end if;
  if p_country is not null and char_length(p_country) > 8 then raise exception 'invalid country'; end if;
  if p_status is null or p_status not between 100 and 599 then raise exception 'invalid status'; end if;

  -- Rate limit: drop quietly so a flood can't tell it is being limited.
  if (
    select count(*) from (
      select 1 from public.page_views
      where visitor_hash = p_visitor_hash and viewed_at > now() - interval '60 seconds'
      limit 30
    ) recent
  ) >= 30 then
    return;
  end if;

  insert into public.page_views (path, country, visitor_hash, status)
  values (p_path, p_country, p_visitor_hash, p_status);
end;
$$;


ALTER FUNCTION "public"."record_page_view"("p_path" "text", "p_visitor_hash" "text", "p_country" "text", "p_status" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reject_signup_request"("p_request_id" "uuid", "p_reason" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not is_admin() then
    raise exception 'Only an admin can reject sign-ups' using errcode = 'insufficient_privilege';
  end if;
  if length(v_reason) = 0 or length(v_reason) > 500 then
    raise exception 'A reason (up to 500 characters) is required — it is sent to the driver';
  end if;

  update public.signup_requests
  set status = 'rejected',
      reason = v_reason,
      decided_by = auth.uid(),
      decided_at = now()
  where id = p_request_id and status = 'pending';
  if not found then
    raise exception 'This sign-up is no longer pending';
  end if;
end;
$$;


ALTER FUNCTION "public"."reject_signup_request"("p_request_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."relink_drivers_from_results"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  linked int;
begin
  -- auth.uid() is null for the service-role key and the SQL editor, which are
  -- both trusted callers; EXECUTE is revoked from anon below so the null case
  -- can't be reached by the public. A signed-in user must be an admin.
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an admin can relink drivers'
      using errcode = 'insufficient_privilege';
  end if;

  with ranked_matches as (
    select
      d.id as driver_id,
      r.cust_id,
      row_number() over (
        partition by d.id
        order by count(*) desc, max(r.created_at) desc, r.cust_id
      ) as rn
    from public.drivers d
    join public.curated_race_results r
      on lower(trim(r.display_name)) = lower(trim(d.name))
    group by d.id, r.cust_id
  ),
  candidate_matches as (
    select driver_id, cust_id
    from ranked_matches
    where rn = 1
  )
  update public.drivers d
  set iracing_cust_id = cm.cust_id
  from candidate_matches cm
  where d.id = cm.driver_id
    and d.iracing_cust_id is null;

  get diagnostics linked = row_count;
  return linked;
end;
$$;


ALTER FUNCTION "public"."relink_drivers_from_results"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."relink_rounds_to_seasons"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  linked int;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an admin can relink rounds to seasons'
      using errcode = 'insufficient_privilege';
  end if;

  with normalized_rounds as (
    select
      cr.subsession_id,
      cr.season_label,
      regexp_replace(lower(trim(cr.season_label)), '[^a-z0-9]', '', 'g') as normalized_label,
      regexp_replace(lower(trim(cr.season_label)), '[^0-9]', '', 'g') as digits_label
    from public.curated_rounds cr
    where cr.season_id is null
      and cr.season_label is not null
  ),
  candidate_matches as (
    select
      nr.subsession_id,
      s.id as season_id,
      row_number() over (
        partition by nr.subsession_id
        order by
          case
            when regexp_replace(lower(trim(s.name)), '[^a-z0-9]', '', 'g') = nr.normalized_label then 0
            else 1
          end,
          case
            when nr.digits_label <> '' and s.number::text = nr.digits_label then 0
            else 1
          end,
          s.number
      ) as rn
    from normalized_rounds nr
    join public.seasons s on (
      regexp_replace(lower(trim(s.name)), '[^a-z0-9]', '', 'g') = nr.normalized_label
      or (
        nr.digits_label <> ''
        and s.number::text = nr.digits_label
      )
    )
  )
  update public.curated_rounds cr
  set season_id = cm.season_id
  from candidate_matches cm
  where cr.subsession_id = cm.subsession_id
    and cm.rn = 1
    and cr.season_id is null;

  get diagnostics linked = row_count;
  return linked;
end;
$$;


ALTER FUNCTION "public"."relink_rounds_to_seasons"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."renumber_season_rounds"("p_season_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  numbered int;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an admin can renumber rounds'
      using errcode = 'insufficient_privilege';
  end if;

  update public.curated_rounds set round_number = null
  where season_id = p_season_id and status = 'unofficial';

  with ordered as (
    select subsession_id,
           row_number() over (order by start_time, subsession_id) as n
    from public.curated_rounds
    where season_id = p_season_id and status <> 'unofficial'
  )
  update public.curated_rounds cr
  set round_number = ordered.n
  from ordered
  where cr.subsession_id = ordered.subsession_id
    and cr.round_number is distinct from ordered.n;

  get diagnostics numbered = row_count;
  return numbered;
end;
$$;


ALTER FUNCTION "public"."renumber_season_rounds"("p_season_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."save_incident_report_review"("p_report_id" "uuid", "p_faults" "jsonb", "p_explanation" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_uid uuid := auth.uid();
  v_found boolean;
  v_closed timestamptz;
  v_name text;
  v_review_id uuid;
  v_old_faults jsonb;
  v_new_faults jsonb;
  v_old_explanation text;
begin
  if v_uid is null or not public.is_admin() then
    raise exception 'admins only';
  end if;

  select true, reviews_closed_at into v_found, v_closed from incident_reports where id = p_report_id;
  if v_found is null then raise exception 'unknown incident report'; end if;
  -- The app matches on "reviews are locked" to tell the steward why the save failed.
  if v_closed is not null then raise exception 'this incident has already been logged; reviews are locked'; end if;
  -- The app matches on "involved in this incident" likewise (0099).
  if public.is_involved_in_incident_report(p_report_id) then
    raise exception 'you were involved in this incident and cannot review it';
  end if;

  if p_faults is null or jsonb_typeof(p_faults) <> 'array' or jsonb_array_length(p_faults) > 50 then
    raise exception 'invalid drivers';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_faults) f
    where jsonb_typeof(f) <> 'object'
      or coalesce(f->>'penalty', '') not in ('none', 'warning', '1', '2', '3', '4', '5', '6', '7')
      or coalesce(f->>'driver_id', '') !~ '^[0-9a-fA-F-]{36}$'
  ) then
    raise exception 'invalid drivers';
  end if;
  if (select count(distinct f->>'driver_id') from jsonb_array_elements(p_faults) f) <> jsonb_array_length(p_faults) then
    raise exception 'invalid drivers';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_faults) f
    where not exists (select 1 from drivers d where d.id = (f->>'driver_id')::uuid)
  ) then
    raise exception 'unknown driver';
  end if;
  if coalesce(btrim(p_explanation), '') = '' or length(p_explanation) > 4000 then
    raise exception 'invalid explanation';
  end if;

  -- Canonical form (sorted by driver) so "same cars, same penalties" compares equal.
  select coalesce(jsonb_agg(jsonb_build_object('driver_id', lower(f->>'driver_id'), 'penalty', f->>'penalty') order by lower(f->>'driver_id')), '[]'::jsonb)
  into v_new_faults
  from jsonb_array_elements(p_faults) f;

  -- A login linked to a roster driver (Admin > Users > Driver) is named after that driver.
  select coalesce(d.name, p.display_name, u.email) into v_name
  from auth.users u left join profiles p on p.id = u.id left join drivers d on d.id = p.driver_id
  where u.id = v_uid;

  select v.id, v.explanation into v_review_id, v_old_explanation
  from incident_report_reviews v
  where v.report_id = p_report_id and v.reviewer_id = v_uid
  for update;

  if v_review_id is null then
    insert into incident_report_reviews (report_id, reviewer_id, reviewer_name, explanation)
    values (p_report_id, v_uid, v_name, btrim(p_explanation))
    returning id into v_review_id;
  else
    select coalesce(jsonb_agg(jsonb_build_object('driver_id', rd.driver_id::text, 'penalty', rd.penalty) order by rd.driver_id::text), '[]'::jsonb)
    into v_old_faults
    from incident_report_review_drivers rd
    where rd.review_id = v_review_id;

    update incident_report_reviews
    set reviewer_name = v_name,
        explanation = btrim(p_explanation),
        -- Only a real change counts as an edit — re-saving unchanged isn't one.
        edited_at = case
          when v_old_explanation is distinct from btrim(p_explanation) or v_old_faults is distinct from v_new_faults
          then now()
          else edited_at
        end
    where id = v_review_id;

    delete from incident_report_review_drivers where review_id = v_review_id;
  end if;

  insert into incident_report_review_drivers (review_id, driver_id, penalty)
  select v_review_id, (f->>'driver_id')::uuid, f->>'penalty'
  from jsonb_array_elements(v_new_faults) f;
end;
$_$;


ALTER FUNCTION "public"."save_incident_report_review"("p_report_id" "uuid", "p_faults" "jsonb", "p_explanation" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_driver_audit_fields"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if tg_op = 'INSERT' then
    new.created_by = auth.uid();
    new.updated_by = auth.uid();
  elsif tg_op = 'UPDATE' then
    new.updated_by = auth.uid();
    new.created_by = old.created_by;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."set_driver_audit_fields"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_driver_car_number"("p_driver_id" "uuid", "p_car_number" integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_holder record;
begin
  if not is_admin() then
    raise exception 'Only an admin can change car numbers'
      using errcode = 'insufficient_privilege';
  end if;

  if p_car_number is not null then
    select d.id, d.name, ds.name as status_name
      into v_holder
    from public.drivers d
    join public.driver_statuses ds on ds.id = d.status_id
    where d.car_number = p_car_number
      and d.id <> p_driver_id;

    if found then
      if v_holder.status_name <> 'Inactive' then
        raise exception 'Car #% is already in use by % (%)', p_car_number, v_holder.name, v_holder.status_name
          using errcode = 'unique_violation';
      end if;
      -- The current holder is Inactive — Logan: "if you overwrite the
      -- number of someone who is inactive, they should go into the
      -- unassigned category by having their number removed." Cleared
      -- BEFORE this driver's own number is set, so the two writes never
      -- collide against the unique index above even momentarily.
      update public.drivers set car_number = null where id = v_holder.id;
    end if;
  end if;

  update public.drivers set car_number = p_car_number where id = p_driver_id;
end;
$$;


ALTER FUNCTION "public"."set_driver_car_number"("p_driver_id" "uuid", "p_car_number" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."stamp_incident_report_reviews_closed"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.reviews_closed_at := coalesce(old.reviews_closed_at, case when new.status = 'logged' then now() end);
  return new;
end;
$$;


ALTER FUNCTION "public"."stamp_incident_report_reviews_closed"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_incident_appeal"("p_id" "uuid", "p_penalty_id" "uuid", "p_message" "text", "p_files" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_subsession bigint;
  v_posted_at timestamptz;
  v_period_hours integer;
  v_file jsonb;
begin
  if v_uid is null then raise exception 'sign in to submit an appeal'; end if;
  if p_id is null then raise exception 'invalid id'; end if;
  if coalesce(btrim(p_message), '') = '' or length(p_message) > 4000 then raise exception 'invalid message'; end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) > 3 then
    raise exception 'invalid files';
  end if;

  select subsession_id into v_subsession from penalties where id = p_penalty_id;
  if v_subsession is null then raise exception 'unknown incident'; end if;

  -- Appeal window: from posting until the appeal period runs out.
  select posted_at into v_posted_at
  from round_incident_status where subsession_id = v_subsession and posted;
  select case when value ~ '^[0-9]{1,4}$' then value::integer end into v_period_hours
  from site_settings where setting_key = 'incident_appeal_period_hours';
  if v_posted_at is null or now() > v_posted_at + make_interval(hours => coalesce(v_period_hours, 24)) then
    raise exception 'the appeal window for this round is closed';
  end if;

  -- Files must be the caller's own uploads for this appeal.
  for v_file in select * from jsonb_array_elements(p_files) loop
    if jsonb_typeof(v_file) <> 'object'
       or coalesce(v_file ->> 'path', '') !~ ('^' || v_uid::text || '/' || p_id::text || '/[0-9]+-[^/]+$')
       or not exists (
         select 1 from storage.objects o
         where o.bucket_id = 'incident-appeals' and o.name = v_file ->> 'path'
       ) then
      raise exception 'invalid files';
    end if;
  end loop;

  -- Per-submitter limits.
  perform pg_advisory_xact_lock(hashtextextended('incident_appeal:' || v_uid::text, 0));
  if (select count(*) from incident_appeals where penalty_id = p_penalty_id and submitter_id = v_uid) >= 3 then
    raise exception 'too many appeals for this incident';
  end if;
  if (select count(*) from incident_appeals where subsession_id = v_subsession and submitter_id = v_uid) >= 10 then
    raise exception 'too many appeals for this round';
  end if;

  -- A login linked to a roster driver (Admin > Users > Driver) is named after that driver.
  select coalesce(d.name, p.display_name, u.email) into v_name
  from auth.users u left join profiles p on p.id = u.id left join drivers d on d.id = p.driver_id
  where u.id = v_uid;

  insert into incident_appeals (id, subsession_id, penalty_id, message, files, submitter_id, submitter_name)
  values (p_id, v_subsession, p_penalty_id, btrim(p_message), p_files, v_uid, v_name);

  return p_id;
end;
$_$;


ALTER FUNCTION "public"."submit_incident_appeal"("p_id" "uuid", "p_penalty_id" "uuid", "p_message" "text", "p_files" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_incident_report"("p_subsession_id" bigint, "p_session" "text", "p_lap" integer, "p_turn" "text", "p_description" "text", "p_driver_ids" "uuid"[]) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_id uuid;
  v_uid uuid := auth.uid();
  v_name text;
  v_start timestamptz;
  v_period_hours integer;
begin
  if p_session is null or p_session !~ '^(race:[0-9]+|qualifying:0|practice:0)$' then
    raise exception 'invalid session';
  end if;
  if p_lap is null or p_lap < 0 or p_lap > 1000 then raise exception 'invalid lap'; end if;
  if coalesce(btrim(p_turn), '') = '' or length(p_turn) > 80 then raise exception 'invalid turn'; end if;
  if p_description is not null and length(p_description) > 2000 then raise exception 'description too long'; end if;
  if p_driver_ids is null or cardinality(p_driver_ids) = 0 or cardinality(p_driver_ids) > 100 then
    raise exception 'at least one car is required';
  end if;

  select start_time into v_start from curated_rounds where subsession_id = p_subsession_id;
  if not found then raise exception 'unknown round'; end if;

  -- Reporting window: closed once posted, or once the period has run out.
  if exists (select 1 from round_incident_status where subsession_id = p_subsession_id and posted) then
    raise exception 'incident reporting is closed for this round';
  end if;
  select case when value ~ '^[0-9]{1,4}$' then value::integer end into v_period_hours
  from site_settings where setting_key = 'incident_report_period_hours';
  if v_start is null or now() > v_start + interval '4 hours' + make_interval(hours => coalesce(v_period_hours, 24)) then
    raise exception 'incident reporting is closed for this round';
  end if;

  -- Per-submitter limits.
  if v_uid is not null then
    perform pg_advisory_xact_lock(hashtextextended('incident_report:' || v_uid::text, 0));
    if (select count(*) from incident_reports where subsession_id = p_subsession_id and reporter_id = v_uid) >= 10 then
      raise exception 'too many incident reports for this round';
    end if;
  else
    perform pg_advisory_xact_lock(hashtextextended('incident_report:anon', 0));
    if (select count(*) from incident_reports where subsession_id = p_subsession_id and reporter_id is null) >= 40 then
      raise exception 'too many incident reports for this round';
    end if;
    if (select count(*) from incident_reports where reporter_id is null and created_at > now() - interval '1 hour') >= 20 then
      raise exception 'too many incident reports, try again later';
    end if;
  end if;

  if v_uid is not null then
    select coalesce(d.name, p.display_name, u.email) into v_name
    from auth.users u left join profiles p on p.id = u.id left join drivers d on d.id = p.driver_id
    where u.id = v_uid;
  end if;

  insert into incident_reports (subsession_id, session, lap, turn, description, reporter_id, reporter_name)
  values (p_subsession_id, p_session, p_lap, btrim(p_turn), nullif(btrim(coalesce(p_description, '')), ''), v_uid, v_name)
  returning id into v_id;

  insert into incident_report_drivers (report_id, driver_id)
  select v_id, d.id from drivers d where d.id = any (p_driver_ids);
  if not found then raise exception 'no valid cars'; end if;

  return v_id;
end;
$_$;


ALTER FUNCTION "public"."submit_incident_report"("p_subsession_id" bigint, "p_session" "text", "p_lap" integer, "p_turn" "text", "p_description" "text", "p_driver_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_kudos"("p_subsession_id" bigint, "p_session" "text", "p_lap" integer, "p_turn" "text", "p_description" "text", "p_clip_url" "text", "p_driver_ids" "uuid"[]) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_id uuid;
  v_uid uuid := auth.uid();
  v_name text;
  v_clip text := nullif(btrim(coalesce(p_clip_url, '')), '');
begin
  if v_uid is null then raise exception 'sign in to share kudos'; end if;
  if p_session is null or p_session !~ '^(race:[0-9]+|qualifying:0|practice:0)$' then
    raise exception 'invalid session';
  end if;
  if p_lap is null or p_lap < 0 then raise exception 'invalid lap'; end if;
  if coalesce(btrim(p_turn), '') = '' or length(p_turn) > 80 then raise exception 'invalid turn'; end if;
  if p_description is not null and length(p_description) > 2000 then raise exception 'description too long'; end if;
  if v_clip is not null and (length(v_clip) > 500 or v_clip !~* '^https?://\S+$') then
    raise exception 'invalid clip link';
  end if;
  if p_driver_ids is null or cardinality(p_driver_ids) = 0 or cardinality(p_driver_ids) > 100 then
    raise exception 'at least one car is required';
  end if;
  if not exists (select 1 from curated_rounds where subsession_id = p_subsession_id) then
    raise exception 'unknown round';
  end if;
  -- A race session must be one this round actually ran (race_scores has a row
  -- per driver per race), so a direct RPC call can't file 'race:99'.
  if p_session like 'race:%' and not exists (
    select 1 from race_scores
    where subsession_id = p_subsession_id and race_number = split_part(p_session, ':', 2)::int
  ) then
    raise exception 'invalid session';
  end if;
  if p_lap > 10000 then raise exception 'invalid lap'; end if;

  -- Linked driver's name, else display name — never the email (see above).
  select coalesce(d.name, p.display_name) into v_name
  from auth.users u left join profiles p on p.id = u.id left join drivers d on d.id = p.driver_id
  where u.id = v_uid;

  insert into kudos (subsession_id, session, lap, turn, description, clip_url, author_id, author_name)
  values (p_subsession_id, p_session, p_lap, btrim(p_turn), nullif(btrim(coalesce(p_description, '')), ''), v_clip, v_uid, v_name)
  returning id into v_id;

  -- Only cars that raced in this round (same set as the dialog's picker);
  -- anything else is dropped, and none left aborts the whole kudos.
  insert into kudos_drivers (kudos_id, driver_id)
  select v_id, d.id from drivers d
  where d.id = any (p_driver_ids)
    and exists (select 1 from race_scores rs where rs.subsession_id = p_subsession_id and rs.driver_id = d.id);
  if not found then raise exception 'no valid cars'; end if;

  return v_id;
end;
$_$;


ALTER FUNCTION "public"."submit_kudos"("p_subsession_id" bigint, "p_session" "text", "p_lap" integer, "p_turn" "text", "p_description" "text", "p_clip_url" "text", "p_driver_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_race_interview"("p_id" "uuid", "p_subsession_id" bigint, "p_audio_path" "text", "p_audio_type" "text", "p_duration_seconds" integer) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_uid uuid := auth.uid();
  v_driver uuid;
  v_start timestamptz;
begin
  if v_uid is null then raise exception 'sign in required'; end if;
  select driver_id into v_driver from profiles where id = v_uid;
  if v_driver is null then raise exception 'account is not linked to a driver'; end if;

  if p_id is null or p_subsession_id is null then raise exception 'invalid interview'; end if;
  -- "<caller's driver id>/<this round>.<ext>" only.
  if p_audio_path is null
     or p_audio_path !~ '^[0-9a-f-]{36}/[0-9]+\.(webm|mp4|ogg)$'
     or split_part(p_audio_path, '/', 1) <> v_driver::text
     or split_part(split_part(p_audio_path, '/', 2), '.', 1) <> p_subsession_id::text then
    raise exception 'invalid audio path';
  end if;
  if p_audio_type is null or p_audio_type !~ '^audio/(webm|mp4|ogg)' then raise exception 'invalid audio type'; end if;
  if p_duration_seconds is null or p_duration_seconds < 1 or p_duration_seconds > 75 then raise exception 'invalid duration'; end if;
  select start_time into v_start from curated_rounds where subsession_id = p_subsession_id;
  if v_start is null then raise exception 'unknown round'; end if;
  if v_start < now() - interval '7 days' then raise exception 'interview window closed'; end if;
  if exists (select 1 from race_interviews where subsession_id = p_subsession_id and driver_id = v_driver) then
    raise exception 'interview limit reached';
  end if;

  insert into race_interviews (id, subsession_id, driver_id, audio_path, audio_type, duration_seconds, submitter_id)
  values (p_id, p_subsession_id, v_driver, p_audio_path, p_audio_type, p_duration_seconds, v_uid);

  return p_id;
end;
$_$;


ALTER FUNCTION "public"."submit_race_interview"("p_id" "uuid", "p_subsession_id" bigint, "p_audio_path" "text", "p_audio_type" "text", "p_duration_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_signup_request"("p_discord_user_id" "text", "p_discord_username" "text", "p_name" "text", "p_numbers" integer[], "p_iracing_cust_id" bigint DEFAULT NULL::bigint) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_number integer;
  v_holder text;
  v_assigned integer;
  v_taken jsonb := '[]'::jsonb;
  v_id uuid;
begin
  if p_discord_user_id is null or p_discord_user_id !~ '^[0-9]{1,25}$' then
    raise exception 'invalid: discord_user_id must be a Discord user ID';
  end if;
  if length(v_name) = 0 or length(v_name) > 80 then
    raise exception 'invalid: name must be 1-80 characters';
  end if;
  if p_numbers is null or cardinality(p_numbers) = 0 or cardinality(p_numbers) > 3 then
    raise exception 'invalid: give 1 to 3 numbers';
  end if;
  if exists (select 1 from unnest(p_numbers) n where n is null or n < 0 or n > 999) then
    raise exception 'invalid: numbers must be between 0 and 999';
  end if;
  if (select count(distinct n) from unnest(p_numbers) n) <> cardinality(p_numbers) then
    raise exception 'invalid: numbers must not repeat';
  end if;
  if p_iracing_cust_id is not null and p_iracing_cust_id <= 0 then
    raise exception 'invalid: iracing_id must be a positive number';
  end if;

  foreach v_number in array p_numbers loop
    -- Same rule as car_number_holder(), except a number held by the person
    -- signing up doesn't block them: a returning driver re-signing with
    -- their own number. "Same person" = same iRacing ID, or the same name
    -- when either side has no iRacing ID (the same test Admin > Sign-ups
    -- uses to suggest a returning driver).
    select d.name into v_holder
    from public.drivers d
    join public.driver_statuses ds on ds.id = d.status_id
    where d.car_number = v_number
      and ds.name <> 'Inactive'
      and not (
        (p_iracing_cust_id is not null and d.iracing_cust_id = p_iracing_cust_id)
        or (lower(d.name) = lower(v_name) and (p_iracing_cust_id is null or d.iracing_cust_id is null))
      )
    limit 1;
    if v_holder is null then
      v_assigned := v_number;
      exit;
    end if;
    v_taken := v_taken || jsonb_build_object('number', v_number, 'holder', v_holder);
    v_holder := null;
  end loop;

  if v_assigned is null then
    return jsonb_build_object('status', 'all_taken', 'taken', v_taken);
  end if;

  -- One pending sign-up per Discord user: signing up again replaces the
  -- pending one instead of queueing a duplicate.
  update public.signup_requests
  set discord_username = nullif(btrim(coalesce(p_discord_username, '')), ''),
      name = v_name,
      iracing_cust_id = p_iracing_cust_id,
      requested_numbers = p_numbers,
      created_at = now()
  where discord_user_id = p_discord_user_id and status = 'pending'
  returning id into v_id;

  if v_id is null then
    insert into public.signup_requests (discord_user_id, discord_username, name, iracing_cust_id, requested_numbers)
    values (p_discord_user_id, nullif(btrim(coalesce(p_discord_username, '')), ''), v_name, p_iracing_cust_id, p_numbers)
    returning id into v_id;
    return jsonb_build_object('status', 'pending', 'request_id', v_id, 'assigned_number', v_assigned, 'taken', v_taken, 'replaced_previous', false);
  end if;

  return jsonb_build_object('status', 'pending', 'request_id', v_id, 'assigned_number', v_assigned, 'taken', v_taken, 'replaced_previous', true);
end;
$_$;


ALTER FUNCTION "public"."submit_signup_request"("p_discord_user_id" "text", "p_discord_username" "text", "p_name" "text", "p_numbers" integer[], "p_iracing_cust_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_driver_statuses"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_active_id       integer;
  v_inactive_id     integer;
  v_changed         integer := 0;
  v_count           integer;
  v_inactivity_days integer;
  v_inactivity_rounds integer;
begin
  if not is_admin() then
    raise exception 'Only an admin can sync driver statuses'
      using errcode = 'insufficient_privilege';
  end if;

  select id into v_active_id from public.driver_statuses where name = 'Active';
  select id into v_inactive_id from public.driver_statuses where name = 'Inactive';
  if v_active_id is null or v_inactive_id is null then
    raise exception 'driver_statuses is missing Active/Inactive rows';
  end if;

  select coalesce((select value from public.site_settings where setting_key = 'inactivity_days')::integer, 90)
    into v_inactivity_days;
  select coalesce((select value from public.site_settings where setting_key = 'inactivity_rounds')::integer, 12)
    into v_inactivity_rounds;
  if v_inactivity_days is null or v_inactivity_days <= 0 then
    v_inactivity_days := 90;
  end if;
  if v_inactivity_rounds is null or v_inactivity_rounds <= 0 then
    v_inactivity_rounds := 12;
  end if;

  -- New/Active -> Inactive (has raced at least once): both thresholds have
  -- passed since their most recent race, and since their last approved
  -- sign-up if they have one.
  update public.drivers d
  set status_id = v_inactive_id
  from public.driver_statuses ds, public.driver_last_race lr
  where ds.id = d.status_id
    and lr.driver_id = d.id
    and ds.name in ('New', 'Active')
    and lr.last_race_at is not null
    and lr.last_race_at < now() - (v_inactivity_days || ' days')::interval
    and lr.rounds_since_last_race >= v_inactivity_rounds
    and (
      d.last_signed_up_at is null
      or (
        d.last_signed_up_at < now() - (v_inactivity_days || ' days')::interval
        and (
          select count(*)::integer
          from public.curated_rounds cr
          where cr.status = 'official'
            and cr.start_time > d.last_signed_up_at
        ) >= v_inactivity_rounds
      )
    );
  get diagnostics v_count = row_count;
  v_changed := v_changed + v_count;

  -- New -> Inactive (never raced at all): same two thresholds, measured
  -- from the later of sign_up_date and last_signed_up_at.
  update public.drivers d
  set status_id = v_inactive_id
  from public.driver_statuses ds, public.driver_last_race lr
  where ds.id = d.status_id
    and lr.driver_id = d.id
    and ds.name = 'New'
    and lr.last_race_at is null
    and greatest(d.sign_up_date::timestamptz, d.last_signed_up_at) is not null
    and greatest(d.sign_up_date::timestamptz, d.last_signed_up_at) < now() - (v_inactivity_days || ' days')::interval
    and (
      select count(*)::integer
      from public.curated_rounds cr
      where cr.status = 'official'
        and cr.start_time > greatest(d.sign_up_date::timestamptz, d.last_signed_up_at)
    ) >= v_inactivity_rounds;
  get diagnostics v_count = row_count;
  v_changed := v_changed + v_count;

  -- Inactive -> Active: logical complement of the raced-before rule
  -- (unchanged from 0063).
  update public.drivers d
  set status_id = v_active_id
  from public.driver_statuses ds, public.driver_last_race lr
  where ds.id = d.status_id
    and lr.driver_id = d.id
    and ds.name = 'Inactive'
    and lr.last_race_at is not null
    and not (
      lr.last_race_at < now() - (v_inactivity_days || ' days')::interval
      and lr.rounds_since_last_race >= v_inactivity_rounds
    );
  get diagnostics v_count = row_count;
  v_changed := v_changed + v_count;

  return v_changed;
end;
$$;


ALTER FUNCTION "public"."sync_driver_statuses"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_results_with_roster"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_default_class_id integer;
  v_new_status_id     integer;
  v_created           text[] := '{}';
  v_linked            text[] := '{}';
  v_entrant           record;
  v_match_count        integer;
  v_match_id           uuid;
  v_match_name         text;
  v_created_name       text;
  v_subsession_id       bigint;
  v_rounds_recalculated integer := 0;
  v_recalc_failed       text[] := '{}';
begin
  if not is_admin() then
    raise exception 'Only an admin can sync results with the roster'
      using errcode = 'insufficient_privilege';
  end if;

  select id into v_default_class_id from public.driver_classes order by sort_order asc limit 1;
  select id into v_new_status_id from public.driver_statuses where name = 'New';
  if v_default_class_id is null or v_new_status_id is null then
    raise exception 'driver_classes/driver_statuses is missing required rows';
  end if;

  for v_entrant in
    select
      rr.cust_id,
      (array_agg(rr.display_name order by rr.subsession_id desc))[1] as display_name
    from public.curated_race_results rr
    join public.curated_rounds cr on cr.subsession_id = rr.subsession_id
    where (cr.season_label is null or cr.season_label ~* '^ATC[0-9]+$')
      and not exists (
        select 1 from public.round_overrides ro
        where ro.subsession_id = rr.subsession_id and ro.is_exhibition
      )
      and not exists (
        select 1 from public.drivers d where d.iracing_cust_id = rr.cust_id
      )
    group by rr.cust_id
  loop
    select count(*) into v_match_count
    from public.drivers d
    where d.iracing_cust_id is null
      and lower(trim(d.name)) = lower(trim(v_entrant.display_name));

    if v_match_count = 1 then
      select d.id, d.name into v_match_id, v_match_name
      from public.drivers d
      where d.iracing_cust_id is null
        and lower(trim(d.name)) = lower(trim(v_entrant.display_name));

      update public.drivers set iracing_cust_id = v_entrant.cust_id where id = v_match_id;
      v_linked := array_append(v_linked, v_match_name);
    else
      insert into public.drivers (name, iracing_cust_id, class_id, status_id, is_rookie)
      values (v_entrant.display_name, v_entrant.cust_id, v_default_class_id, v_new_status_id, true)
      returning name into v_created_name;
      v_created := array_append(v_created, v_created_name);
    end if;

    -- This cust_id is rostered now — go back and recompute every round
    -- they already have raw results in, so their history isn't stuck
    -- invisible until someone happens to click Admin > Seasons' Recalculate
    -- for the right season. See this function's own header comment above.
    for v_subsession_id in
      select distinct rr2.subsession_id
      from public.curated_race_results rr2
      where rr2.cust_id = v_entrant.cust_id
    loop
      begin
        perform public.recalculate_race_scores(v_subsession_id);
        v_rounds_recalculated := v_rounds_recalculated + 1;
      exception when others then
        v_recalc_failed := array_append(v_recalc_failed, v_subsession_id::text || ': ' || sqlerrm);
      end;
    end loop;
  end loop;

  return jsonb_build_object(
    'created', to_jsonb(v_created),
    'linked', to_jsonb(v_linked),
    'roundsRecalculated', v_rounds_recalculated,
    'recalcFailed', to_jsonb(v_recalc_failed)
  );
end;
$_$;


ALTER FUNCTION "public"."sync_results_with_roster"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_rookie_status"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_changed integer := 0;
begin
  if not is_admin() then
    raise exception 'Only an admin can sync rookie status'
      using errcode = 'insufficient_privilege';
  end if;

  with season_appearances as (
    select driver_id, season_id, count(distinct subsession_id) as appearances
    from public.driver_round_totals
    group by driver_id, season_id
  ),
  qualified as (
    select distinct driver_id
    from season_appearances
    where appearances >= 3
  )
  update public.drivers d
  set is_rookie = false
  from qualified q
  where q.driver_id = d.id
    and d.is_rookie = true;
  get diagnostics v_changed = row_count;

  return v_changed;
end;
$$;


ALTER FUNCTION "public"."sync_rookie_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_my_driver_profile"("p_bio" "text", "p_photo_url" "text" DEFAULT NULL::"text", "p_set_photo" boolean DEFAULT false) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_driver_id uuid;
  v_bio text := nullif(btrim(coalesce(p_bio, '')), '');
begin
  select driver_id into v_driver_id from public.profiles where id = auth.uid();
  if v_driver_id is null then
    raise exception 'Your login is not linked to a driver.';
  end if;

  if v_bio is not null and char_length(v_bio) > 500 then
    raise exception 'Bio is limited to 500 characters.';
  end if;

  if p_set_photo and p_photo_url is not null
     and position('/storage/v1/object/public/photos/driver-avatars/' || v_driver_id::text || '/' in p_photo_url) = 0 then
    raise exception 'Invalid photo location.';
  end if;

  update public.drivers
     set bio = v_bio,
         photo_url = case when p_set_photo then p_photo_url else photo_url end
   where id = v_driver_id;
end;
$$;


ALTER FUNCTION "public"."update_my_driver_profile"("p_bio" "text", "p_photo_url" "text", "p_set_photo" boolean) OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."activity_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "actor_id" "uuid",
    "actor_name" "text" NOT NULL,
    "action" "text" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_label" "text",
    "entity_id" "text",
    "details" "text",
    "file_url" "text",
    "file_name" "text",
    CONSTRAINT "activity_log_action_check" CHECK (("action" = ANY (ARRAY['add'::"text", 'edit'::"text", 'delete'::"text"])))
);


ALTER TABLE "public"."activity_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."car_logos" (
    "car_name" "text" NOT NULL,
    "logo_url" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."car_logos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."champion_photos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "season_id" "uuid" NOT NULL,
    "class_id" integer NOT NULL,
    "driver_id" "uuid" NOT NULL,
    "image_url" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "champion_photos_sort_order_check" CHECK ((("sort_order" >= 0) AND ("sort_order" < 5)))
);


ALTER TABLE "public"."champion_photos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."circuit_layouts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "circuit_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "length_km" numeric,
    "lap_record_holder" "text",
    "lap_record_date" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "lap_record_seconds" numeric,
    "image_url" "text",
    "corners" integer,
    "pit_entry_difficulty" "text",
    "pit_entry_note" "text",
    "pit_entry_x" numeric,
    "pit_entry_y" numeric,
    "pit_exit_difficulty" "text",
    "pit_exit_note" "text",
    "pit_exit_x" numeric,
    "pit_exit_y" numeric,
    CONSTRAINT "circuit_layouts_pit_entry_difficulty_check" CHECK ((("pit_entry_difficulty" IS NULL) OR ("pit_entry_difficulty" = ANY (ARRAY['easy'::"text", 'moderate'::"text", 'difficult'::"text"])))),
    CONSTRAINT "circuit_layouts_pit_exit_difficulty_check" CHECK ((("pit_exit_difficulty" IS NULL) OR ("pit_exit_difficulty" = ANY (ARRAY['easy'::"text", 'moderate'::"text", 'difficult'::"text"])))),
    CONSTRAINT "circuit_layouts_pit_points_check" CHECK (((("pit_entry_x" IS NULL) OR (("pit_entry_x" >= (0)::numeric) AND ("pit_entry_x" <= (100)::numeric))) AND (("pit_entry_y" IS NULL) OR (("pit_entry_y" >= (0)::numeric) AND ("pit_entry_y" <= (100)::numeric))) AND (("pit_exit_x" IS NULL) OR (("pit_exit_x" >= (0)::numeric) AND ("pit_exit_x" <= (100)::numeric))) AND (("pit_exit_y" IS NULL) OR (("pit_exit_y" >= (0)::numeric) AND ("pit_exit_y" <= (100)::numeric)))))
);


ALTER TABLE "public"."circuit_layouts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."circuits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "logo_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "location" "text",
    "latitude" double precision,
    "longitude" double precision,
    "logo_background" "text",
    CONSTRAINT "circuits_latitude_range" CHECK ((("latitude" IS NULL) OR (("latitude" >= ('-90'::integer)::double precision) AND ("latitude" <= (90)::double precision)))),
    CONSTRAINT "circuits_logo_background_check" CHECK ((("logo_background" IS NULL) OR ("logo_background" = ANY (ARRAY['light'::"text", 'dark'::"text"])))),
    CONSTRAINT "circuits_longitude_range" CHECK ((("longitude" IS NULL) OR (("longitude" >= ('-180'::integer)::double precision) AND ("longitude" <= (180)::double precision))))
);


ALTER TABLE "public"."circuits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."curated_practice_results" (
    "subsession_id" bigint NOT NULL,
    "cust_id" bigint NOT NULL,
    "display_name" "text" NOT NULL,
    "car_class_name" "text",
    "best_lap_ten_thousandths" bigint,
    "laps" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."curated_practice_results" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."curated_qualifying" (
    "subsession_id" bigint NOT NULL,
    "cust_id" bigint NOT NULL,
    "display_name" "text" NOT NULL,
    "car_class_name" "text",
    "qual_position" integer NOT NULL,
    "best_lap_ten_thousandths" bigint,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."curated_qualifying" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."curated_race_results" (
    "subsession_id" bigint NOT NULL,
    "race_number" integer NOT NULL,
    "cust_id" bigint NOT NULL,
    "display_name" "text" NOT NULL,
    "car_name" "text",
    "car_class_name" "text",
    "finish_position" integer NOT NULL,
    "starting_position" integer,
    "laps_complete" integer,
    "laps_led" integer,
    "interval_ten_thousandths" bigint,
    "average_lap_ten_thousandths" bigint,
    "best_lap_ten_thousandths" bigint,
    "incidents" integer,
    "reason_out" "text",
    "penalty_points" integer DEFAULT 0 NOT NULL,
    "adjusted_position" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "curated_race_results_race_number_check" CHECK (("race_number" >= 1))
);


ALTER TABLE "public"."curated_race_results" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."curated_rounds" (
    "subsession_id" bigint NOT NULL,
    "start_time" timestamp with time zone NOT NULL,
    "track_name" "text" NOT NULL,
    "season_label" "text",
    "season_id" "uuid",
    "round_number" integer,
    "format" "text",
    "strength_of_field" integer,
    "num_drivers" integer,
    "status" "text" DEFAULT 'official'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "layout" "text",
    "event_id" "uuid",
    "series_name" "text",
    CONSTRAINT "curated_rounds_format_check" CHECK (("format" = ANY (ARRAY['endurance'::"text", 'sprint'::"text"])))
);


ALTER TABLE "public"."curated_rounds" OWNER TO "postgres";


COMMENT ON COLUMN "public"."curated_rounds"."round_number" IS 'Round ordinal within season_id, 1-based. Derivable from start_time order, but stored because the rulebook references rounds directly (§2.13 "prior to round 4", §3.9 "after round 2", §5.29 probation "4 rounds") and a stored value survives a reschedule or a non-championship event landing mid-season.';



CREATE TABLE IF NOT EXISTS "public"."driver_classes" (
    "id" integer NOT NULL,
    "name" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."driver_classes" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."driver_classes_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."driver_classes_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."driver_classes_id_seq" OWNED BY "public"."driver_classes"."id";



CREATE TABLE IF NOT EXISTS "public"."drivers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "car_number" integer,
    "name" "text" NOT NULL,
    "status_id" integer NOT NULL,
    "class_id" integer NOT NULL,
    "team_id" "uuid",
    "is_rookie" boolean DEFAULT false NOT NULL,
    "car" "text",
    "appearances" integer DEFAULT 0 NOT NULL,
    "starts" integer DEFAULT 0 NOT NULL,
    "seasons_count" integer DEFAULT 0 NOT NULL,
    "penalty_points" integer DEFAULT 0 NOT NULL,
    "penalty_points_max" integer DEFAULT 11 NOT NULL,
    "photo_url" "text",
    "bio" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "iracing_cust_id" bigint,
    "sign_up_date" "date",
    "on_probation" boolean DEFAULT false NOT NULL,
    "probation_started_at" "date",
    "is_hall_of_fame" boolean DEFAULT false NOT NULL,
    "nationality_1" "text",
    "nationality_2" "text",
    "starting_irating" integer,
    "created_by" "uuid",
    "updated_by" "uuid",
    "is_ai" boolean DEFAULT false NOT NULL,
    "last_signed_up_at" timestamp with time zone,
    CONSTRAINT "drivers_starting_irating_range" CHECK ((("starting_irating" IS NULL) OR (("starting_irating" >= 0) AND ("starting_irating" <= 20000))))
);


ALTER TABLE "public"."drivers" OWNER TO "postgres";


COMMENT ON COLUMN "public"."drivers"."iracing_cust_id" IS 'iRacing customer id this roster driver competes under. Soft join key to curated_race_results.cust_id (not a FK). Admin-populated.';



COMMENT ON COLUMN "public"."drivers"."starting_irating" IS 'Driver''s iRating when they joined ATC. Reference only — iRatings on iRacing typically run 500-12000, but this isn''t enforced as a hard bound.';



COMMENT ON COLUMN "public"."drivers"."created_by" IS 'auth.users.id of the admin who created this driver row (auto-stamped by drivers_set_audit_fields — see that trigger). Null for rows that predate this column.';



COMMENT ON COLUMN "public"."drivers"."updated_by" IS 'auth.users.id of the admin who most recently modified this driver row (auto-stamped by drivers_set_audit_fields). Null for rows that predate this column and haven''t been touched since.';



COMMENT ON COLUMN "public"."drivers"."last_signed_up_at" IS 'When a Discord sign-up for this driver was last approved (0098). Restarts the inactivity clock in sync_driver_statuses().';



CREATE OR REPLACE VIEW "public"."driver_last_race" WITH ("security_invoker"='true') AS
 WITH "lr" AS (
         SELECT "d"."id" AS "driver_id",
            "max"("cr"."start_time") AS "last_race_at"
           FROM (("public"."drivers" "d"
             LEFT JOIN "public"."curated_race_results" "rr" ON (("rr"."cust_id" = "d"."iracing_cust_id")))
             LEFT JOIN "public"."curated_rounds" "cr" ON (("cr"."subsession_id" = "rr"."subsession_id")))
          GROUP BY "d"."id"
        )
 SELECT "driver_id",
    "last_race_at",
        CASE
            WHEN ("last_race_at" IS NULL) THEN NULL::integer
            ELSE ( SELECT ("count"(*))::integer AS "count"
               FROM "public"."curated_rounds" "cr2"
              WHERE (("cr2"."status" = 'official'::"text") AND ("cr2"."start_time" > "lr"."last_race_at")))
        END AS "rounds_since_last_race"
   FROM "lr";


ALTER VIEW "public"."driver_last_race" OWNER TO "postgres";


COMMENT ON VIEW "public"."driver_last_race" IS 'Every driver''s most recent race (by curated_rounds.start_time), matched via drivers.iracing_cust_id, plus a count of official league rounds run since then (league-wide, not season/class-scoped) — null if they have no iracing_cust_id set or have never appeared in curated_race_results. Backs both sync_driver_statuses() and the admin driver edit page''s inactivity note. See 0040_inactivity_90d_or_12_rounds.sql for the 90-day/12-round threshold this feeds.';



CREATE TABLE IF NOT EXISTS "public"."driver_season_car_numbers" (
    "driver_id" "uuid" NOT NULL,
    "season_id" "uuid" NOT NULL,
    "car_number" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "driver_season_car_numbers_car_number_check" CHECK (("car_number" >= 0))
);


ALTER TABLE "public"."driver_season_car_numbers" OWNER TO "postgres";


COMMENT ON TABLE "public"."driver_season_car_numbers" IS 'Optional override of which car number a driver used in a given season — falls back to drivers.car_number (their current number) when no row exists for a driver+season. Needed because a driver''s number can change over their career; the manual Race Results and Incident Report CSV importers resolve a CSV row''s driver_car_number to a driver_id via this table (for the round''s season) before falling back to drivers.car_number, so a driver whose number has since changed or been cleared still resolves correctly for past rounds.';



CREATE TABLE IF NOT EXISTS "public"."driver_season_classes" (
    "driver_id" "uuid" NOT NULL,
    "season_id" "uuid" NOT NULL,
    "class_id" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."driver_season_classes" OWNER TO "postgres";


COMMENT ON TABLE "public"."driver_season_classes" IS 'Optional override of which class a driver raced as a in a given season — falls back to drivers.class_id (their current class) when no row exists for a driver+season. Needed because a driver''s class can change over their career (e.g. Gamma didn''t exist before ATC16), so scoring an old season by a driver''s CURRENT class can misattribute them. Populated by a manual data import, not any admin UI form.';



CREATE TABLE IF NOT EXISTS "public"."driver_statuses" (
    "id" integer NOT NULL,
    "name" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."driver_statuses" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."driver_statuses_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."driver_statuses_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."driver_statuses_id_seq" OWNED BY "public"."driver_statuses"."id";



CREATE TABLE IF NOT EXISTS "public"."events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "circuit_id" "uuid",
    "layout" "text",
    "event_date" "date" NOT NULL,
    "format" "text" DEFAULT 'sprint'::"text" NOT NULL,
    "fuel_limit_pct" integer,
    "results_url" "text",
    "practice_start_time" time without time zone,
    "practice_minutes" integer,
    "practice_weather" "text",
    "qualifying_start_time" time without time zone,
    "qualifying_minutes" integer,
    "qualifying_laps" integer,
    "qualifying_weather" "text",
    "race1_start_time" time without time zone,
    "race1_laps" integer,
    "race1_weather" "text",
    "race2_start_time" time without time zone,
    "race2_laps" integer,
    "race2_weather" "text",
    "race3_start_time" time without time zone,
    "race3_laps" integer,
    "race3_weather" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "practice_sim_time" time without time zone,
    "qualifying_sim_time" time without time zone,
    "race1_sim_time" time without time zone,
    "race2_sim_time" time without time zone,
    "race3_sim_time" time without time zone,
    "category" "text" DEFAULT 'championship'::"text" NOT NULL,
    "season_id" "uuid",
    "round_number" integer,
    "subsession_id" bigint,
    "race1_wet_affected" boolean DEFAULT false NOT NULL,
    "race2_wet_affected" boolean DEFAULT false NOT NULL,
    "race3_wet_affected" boolean DEFAULT false NOT NULL,
    "title" "text",
    "subtitle" "text",
    "rules" "text",
    CONSTRAINT "events_category_check" CHECK (("category" = ANY (ARRAY['championship'::"text", 'test'::"text", 'exhibition'::"text", 'holiday'::"text", 'iracing'::"text"]))),
    CONSTRAINT "events_circuit_or_title_check" CHECK (((("category" = ANY (ARRAY['holiday'::"text", 'iracing'::"text"])) AND ("circuit_id" IS NULL) AND ("title" IS NOT NULL)) OR (("category" <> ALL (ARRAY['holiday'::"text", 'iracing'::"text"])) AND ("circuit_id" IS NOT NULL)))),
    CONSTRAINT "events_format_check" CHECK (("format" = ANY (ARRAY['endurance'::"text", 'sprint'::"text", 'special'::"text"]))),
    CONSTRAINT "events_practice_weather_check" CHECK (("practice_weather" = ANY (ARRAY['clear'::"text", 'partly_cloudy'::"text", 'overcast'::"text", 'raining'::"text", 'mixed'::"text"]))),
    CONSTRAINT "events_qualifying_weather_check" CHECK (("qualifying_weather" = ANY (ARRAY['clear'::"text", 'partly_cloudy'::"text", 'overcast'::"text", 'raining'::"text", 'mixed'::"text"]))),
    CONSTRAINT "events_race1_weather_check" CHECK (("race1_weather" = ANY (ARRAY['clear'::"text", 'partly_cloudy'::"text", 'overcast'::"text", 'raining'::"text", 'mixed'::"text"]))),
    CONSTRAINT "events_race2_weather_check" CHECK (("race2_weather" = ANY (ARRAY['clear'::"text", 'partly_cloudy'::"text", 'overcast'::"text", 'raining'::"text", 'mixed'::"text"]))),
    CONSTRAINT "events_race3_weather_check" CHECK (("race3_weather" = ANY (ARRAY['clear'::"text", 'partly_cloudy'::"text", 'overcast'::"text", 'raining'::"text", 'mixed'::"text"]))),
    CONSTRAINT "events_season_round_paired" CHECK ((("season_id" IS NULL) = ("round_number" IS NULL)))
);


ALTER TABLE "public"."events" OWNER TO "postgres";


COMMENT ON COLUMN "public"."events"."circuit_id" IS 'Nullable since 0073_holiday_iracing_events.sql — every category except HOLIDAY/IRACING still requires one (events_circuit_or_title_check).';



COMMENT ON COLUMN "public"."events"."category" IS 'championship (default, expects season_id/round_number) | test (grey, season-agnostic) | exhibition (gradient, season-agnostic) | holiday (gold, season-agnostic + circuit-less) | iracing (blue, season-agnostic + circuit-less).';



COMMENT ON COLUMN "public"."events"."season_id" IS 'Which season this event''s round belongs to, if any -- paired with round_number (both null or both set). Auto-matched against curated_rounds live, not a stored link -- see getEventRound() in results.ts.';



COMMENT ON COLUMN "public"."events"."round_number" IS 'Round ordinal within season_id (curated_rounds.round_number''s own numbering) -- set at scheduling time, before any curated_rounds row for it may even exist yet.';



COMMENT ON COLUMN "public"."events"."subsession_id" IS 'Manual override/pin to a specific curated_rounds row, for when season_id+round_number auto-matching isn''t applicable (season-agnostic TEST/EXHIBITION events) or isn''t precise enough. Prefer season_id+round_number auto-matching when it applies.';



COMMENT ON COLUMN "public"."events"."race1_wet_affected" IS 'Admin-marked after the fact: did Race 1 actually run in wet conditions? Independent of race1_weather (the pre-scheduled forecast).';



COMMENT ON COLUMN "public"."events"."race2_wet_affected" IS 'Same as race1_wet_affected, for Race 2.';



COMMENT ON COLUMN "public"."events"."race3_wet_affected" IS 'Same as race1_wet_affected, for Race 3.';



COMMENT ON COLUMN "public"."events"."title" IS 'Display title for a HOLIDAY/IRACING event, shown in place of the circuit name — required for those two categories, null for every other one (which use circuit_id + circuits.name instead). See events_circuit_or_title_check.';



COMMENT ON COLUMN "public"."events"."subtitle" IS 'Optional subtitle for a HOLIDAY/IRACING event, shown in place of the layout name. Null otherwise.';



CREATE TABLE IF NOT EXISTS "public"."hall_of_fame_photos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "driver_id" "uuid" NOT NULL,
    "image_url" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "hall_of_fame_photos_sort_order_check" CHECK ((("sort_order" >= 0) AND ("sort_order" < 5)))
);


ALTER TABLE "public"."hall_of_fame_photos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."incident_appeals" (
    "id" "uuid" NOT NULL,
    "subsession_id" bigint NOT NULL,
    "penalty_id" "uuid" NOT NULL,
    "message" "text" NOT NULL,
    "files" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "submitter_id" "uuid",
    "submitter_name" "text",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "incident_appeals_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'reviewed'::"text", 'dismissed'::"text"])))
);


ALTER TABLE "public"."incident_appeals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."incident_report_drivers" (
    "report_id" "uuid" NOT NULL,
    "driver_id" "uuid" NOT NULL
);


ALTER TABLE "public"."incident_report_drivers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."incident_report_review_drivers" (
    "review_id" "uuid" NOT NULL,
    "driver_id" "uuid" NOT NULL,
    "penalty" "text" NOT NULL,
    CONSTRAINT "incident_report_review_drivers_penalty_check" CHECK (("penalty" = ANY (ARRAY['none'::"text", 'warning'::"text", '1'::"text", '2'::"text", '3'::"text", '4'::"text", '5'::"text", '6'::"text", '7'::"text"])))
);


ALTER TABLE "public"."incident_report_review_drivers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."incident_report_reviews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_id" "uuid" NOT NULL,
    "reviewer_id" "uuid" NOT NULL,
    "reviewer_name" "text",
    "explanation" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "edited_at" timestamp with time zone,
    CONSTRAINT "incident_report_reviews_explanation_check" CHECK ((("length"("btrim"("explanation")) > 0) AND ("length"("explanation") <= 4000)))
);


ALTER TABLE "public"."incident_report_reviews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."incident_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "subsession_id" bigint NOT NULL,
    "session" "text" NOT NULL,
    "lap" integer NOT NULL,
    "turn" "text" NOT NULL,
    "description" "text",
    "reporter_id" "uuid",
    "reporter_name" "text",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reviews_closed_at" timestamp with time zone,
    "dismissal_reason" "text",
    CONSTRAINT "incident_reports_dismissal_reason_len" CHECK ((("dismissal_reason" IS NULL) OR (("char_length"("dismissal_reason") >= 1) AND ("char_length"("dismissal_reason") <= 500)))),
    CONSTRAINT "incident_reports_lap_check" CHECK (("lap" >= 0)),
    CONSTRAINT "incident_reports_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'logged'::"text", 'dismissed'::"text"])))
);


ALTER TABLE "public"."incident_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."kudos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "subsession_id" bigint NOT NULL,
    "session" "text" NOT NULL,
    "lap" integer NOT NULL,
    "turn" "text" NOT NULL,
    "description" "text",
    "clip_url" "text",
    "author_id" "uuid" NOT NULL,
    "author_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "kudos_clip_url_check" CHECK ((("clip_url" IS NULL) OR (("length"("clip_url") <= 500) AND ("clip_url" ~* '^https?://\S+$'::"text")))),
    CONSTRAINT "kudos_description_check" CHECK ((("description" IS NULL) OR ("length"("description") <= 2000))),
    CONSTRAINT "kudos_lap_check" CHECK ((("lap" >= 0) AND ("lap" <= 10000))),
    CONSTRAINT "kudos_turn_check" CHECK ((("length"("turn") >= 1) AND ("length"("turn") <= 80)))
);


ALTER TABLE "public"."kudos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."kudos_drivers" (
    "kudos_id" "uuid" NOT NULL,
    "driver_id" "uuid" NOT NULL
);


ALTER TABLE "public"."kudos_drivers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."layout_corners" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "layout_id" "uuid" NOT NULL,
    "label" "text" NOT NULL,
    "x" numeric NOT NULL,
    "y" numeric NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "layout_corners_label_check" CHECK ((("char_length"("label") >= 1) AND ("char_length"("label") <= 8))),
    CONSTRAINT "layout_corners_x_check" CHECK ((("x" >= (0)::numeric) AND ("x" <= (100)::numeric))),
    CONSTRAINT "layout_corners_y_check" CHECK ((("y" >= (0)::numeric) AND ("y" <= (100)::numeric)))
);


ALTER TABLE "public"."layout_corners" OWNER TO "postgres";


COMMENT ON TABLE "public"."layout_corners" IS 'Where a numbered corner is on its layout''s map — x/y are percentages (0-100) of the map image. Placed by an admin in the layout map editor; used to circle reported turns on the Reported Incidents page.';



CREATE TABLE IF NOT EXISTS "public"."layout_incident_pins" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "layout_id" "uuid" NOT NULL,
    "penalty_id" "uuid" NOT NULL,
    "x" numeric NOT NULL,
    "y" numeric NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "layout_incident_pins_x_check" CHECK ((("x" >= (0)::numeric) AND ("x" <= (100)::numeric))),
    CONSTRAINT "layout_incident_pins_y_check" CHECK ((("y" >= (0)::numeric) AND ("y" <= (100)::numeric)))
);


ALTER TABLE "public"."layout_incident_pins" OWNER TO "postgres";


COMMENT ON TABLE "public"."layout_incident_pins" IS 'Where an incident happened on its layout''s map — x/y are percentages (0-100) of the map image. Placed by an admin on /admin/circuits/<id>/map/<layoutId>; drawn (and turned into a heat layer) on the Event Briefing page''s layout map for posted incidents.';



CREATE TABLE IF NOT EXISTS "public"."manual_awards" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "season_id" "uuid" NOT NULL,
    "award_key" "text" NOT NULL,
    "driver_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "manual_awards_award_key_check" CHECK (("award_key" = ANY (ARRAY['best_racecraft'::"text", 'most_improved'::"text"])))
);


ALTER TABLE "public"."manual_awards" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."manual_result_imports" (
    "import_key" "text" NOT NULL,
    "subsession_id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."manual_result_imports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."media_graphics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "image_url" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."media_graphics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."media_meetup_drivers" (
    "meetup_id" "uuid" NOT NULL,
    "driver_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."media_meetup_drivers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."media_meetups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "photo_url" "text",
    "latitude" double precision NOT NULL,
    "longitude" double precision NOT NULL,
    "location_label" "text",
    "meetup_date" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."media_meetups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."media_videos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "category" "text" NOT NULL,
    "title" "text" NOT NULL,
    "youtube_url" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "media_videos_category_check" CHECK (("category" = ANY (ARRAY['cinematic'::"text", 'educational'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."media_videos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."news_post_drivers" (
    "post_id" "uuid" NOT NULL,
    "driver_id" "uuid" NOT NULL
);


ALTER TABLE "public"."news_post_drivers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."news_post_tags" (
    "post_id" "uuid" NOT NULL,
    "tag_id" "uuid" NOT NULL
);


ALTER TABLE "public"."news_post_tags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."news_posts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "title" "text" NOT NULL,
    "excerpt" "text",
    "body" "text" NOT NULL,
    "cover_image_url" "text",
    "author_name" "text" NOT NULL,
    "status" "text" DEFAULT 'published'::"text" NOT NULL,
    "season_id" "uuid",
    "published_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "round_subsession_id" bigint,
    "season_label" "text",
    CONSTRAINT "news_posts_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'published'::"text"])))
);


ALTER TABLE "public"."news_posts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."news_tags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."news_tags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organization_team_seasons" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "team_id" "uuid" NOT NULL,
    "season_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."organization_team_seasons" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organizations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."organizations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."page_banners" (
    "page_key" "text" NOT NULL,
    "image_url" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."page_banners" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."page_views" (
    "id" bigint NOT NULL,
    "path" "text" NOT NULL,
    "country" "text",
    "visitor_hash" "text" NOT NULL,
    "viewed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" integer DEFAULT 200 NOT NULL
);


ALTER TABLE "public"."page_views" OWNER TO "postgres";


ALTER TABLE "public"."page_views" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."page_views_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."penalties" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "subsession_id" bigint NOT NULL,
    "race_number" integer NOT NULL,
    "driver_id" "uuid",
    "incident_number" "text",
    "lap" integer,
    "description" "text",
    "time_penalty_seconds" numeric,
    "points_penalty" integer DEFAULT 0 NOT NULL,
    "penalty_points" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_warning" boolean DEFAULT false NOT NULL,
    "is_appealed" boolean DEFAULT false NOT NULL,
    "appeal_result" "text",
    "appeal_time_penalty_seconds" numeric,
    "appeal_points_penalty" integer DEFAULT 0 NOT NULL,
    "appeal_penalty_points" integer DEFAULT 0 NOT NULL,
    "session_type" "text" DEFAULT 'race'::"text" NOT NULL,
    CONSTRAINT "penalties_session_type_check" CHECK (("session_type" = ANY (ARRAY['race'::"text", 'qualifying'::"text", 'practice'::"text"])))
);


ALTER TABLE "public"."penalties" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."penalty_involved_drivers" (
    "penalty_id" "uuid" NOT NULL,
    "driver_id" "uuid" NOT NULL
);


ALTER TABLE "public"."penalty_involved_drivers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."penalty_offense_links" (
    "penalty_id" "uuid" NOT NULL,
    "offense_id" "uuid" NOT NULL
);


ALTER TABLE "public"."penalty_offense_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."penalty_offenses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "reference_points" "text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."penalty_offenses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "role" "text" DEFAULT 'driver'::"text" NOT NULL,
    "display_name" "text",
    "driver_id" "uuid",
    "iracing_cust_id" bigint,
    "iracing_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'driver'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."race_interviews" (
    "id" "uuid" NOT NULL,
    "subsession_id" bigint NOT NULL,
    "driver_id" "uuid" NOT NULL,
    "audio_path" "text" NOT NULL,
    "audio_type" "text" NOT NULL,
    "duration_seconds" integer NOT NULL,
    "submitter_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "race_interviews_duration_seconds_check" CHECK ((("duration_seconds" >= 1) AND ("duration_seconds" <= 75)))
);


ALTER TABLE "public"."race_interviews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."race_links" (
    "subsession_id" bigint NOT NULL,
    "race_number" integer NOT NULL,
    "iracing_subsession_id" bigint,
    "replay_url" "text",
    "broadcast_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "incident_report_url" "text",
    "photo_album_url" "text"
);


ALTER TABLE "public"."race_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."race_scores" (
    "subsession_id" bigint NOT NULL,
    "race_number" integer NOT NULL,
    "driver_id" "uuid" NOT NULL,
    "season_id" "uuid",
    "class_id" integer NOT NULL,
    "team_id" "uuid",
    "finish_points" integer DEFAULT 0 NOT NULL,
    "class_points" integer DEFAULT 0 NOT NULL,
    "finesse_bonus" integer DEFAULT 0 NOT NULL,
    "pole_bonus" integer DEFAULT 0 NOT NULL,
    "points_deduction" integer DEFAULT 0 NOT NULL,
    "scored_position" integer,
    "classified" boolean DEFAULT true NOT NULL,
    "dsq" boolean DEFAULT false NOT NULL,
    "source" "text" DEFAULT 'computed'::"text" NOT NULL,
    "aggression_bonus" integer DEFAULT 0 NOT NULL,
    "lap_led_bonus" integer DEFAULT 0 NOT NULL,
    "fewest_incidents_bonus" integer DEFAULT 0 NOT NULL,
    "fastest_lap_bonus" integer DEFAULT 0 NOT NULL,
    "sprint_sweep_bonus" integer DEFAULT 0 NOT NULL,
    "total_points" integer GENERATED ALWAYS AS (((((((((("finish_points" + "class_points") + "finesse_bonus") + "pole_bonus") + "aggression_bonus") + "lap_led_bonus") + "fewest_incidents_bonus") + "fastest_lap_bonus") + "sprint_sweep_bonus") + "points_deduction")) STORED,
    CONSTRAINT "race_scores_source_check" CHECK (("source" = ANY (ARRAY['computed'::"text", 'imported'::"text"])))
);


ALTER TABLE "public"."race_scores" OWNER TO "postgres";


COMMENT ON COLUMN "public"."race_scores"."lap_led_bonus" IS 'New bonus (Aug 2026): awarded when this driver led at least one lap in this race. Race-scoped only (rules.bonuses.lap_led has no per field). Zero unless rules.bonuses.lap_led.enabled is true.';



COMMENT ON COLUMN "public"."race_scores"."fewest_incidents_bonus" IS 'New bonus (Aug 2026): awarded to whoever has the fewest incidents among drivers finishing in the top rules.bonuses.fewest_incidents.top_x — scoped per race or per round per rules.bonuses.fewest_incidents.per. Round-scoped awards land on race_number 1 only, same convention as pole_bonus. Zero unless enabled.';



COMMENT ON COLUMN "public"."race_scores"."fastest_lap_bonus" IS 'New bonus (Aug 2026): awarded to whoever set the fastest single lap among drivers finishing in the top rules.bonuses.fastest_lap.top_x — scoped per race or per round per rules.bonuses.fastest_lap.per. Round-scoped awards land on race_number 1 only. Zero unless enabled.';



COMMENT ON COLUMN "public"."race_scores"."sprint_sweep_bonus" IS 'New bonus (Aug 2026): awarded once (on race_number 1) when a driver wins every race of a sprint round with 2+ races. Zero unless rules.bonuses.sprint_sweep.enabled is true.';



CREATE TABLE IF NOT EXISTS "public"."round_incident_status" (
    "subsession_id" bigint NOT NULL,
    "posted" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "posted_at" timestamp with time zone
);


ALTER TABLE "public"."round_incident_status" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."race_scores_public" WITH ("security_invoker"='false') AS
 SELECT "rs"."subsession_id",
    "rs"."race_number",
    "rs"."driver_id",
    "rs"."season_id",
    "rs"."class_id",
    "rs"."team_id",
    "rs"."finish_points",
    "rs"."class_points",
    "rs"."finesse_bonus",
    "rs"."pole_bonus",
        CASE
            WHEN "v"."penalties_visible" THEN "rs"."points_deduction"
            ELSE 0
        END AS "points_deduction",
    "rs"."scored_position",
    "rs"."classified",
    "rs"."dsq",
    "rs"."source",
    "rs"."aggression_bonus",
    "rs"."lap_led_bonus",
    "rs"."fewest_incidents_bonus",
    "rs"."fastest_lap_bonus",
    "rs"."sprint_sweep_bonus",
        CASE
            WHEN "v"."penalties_visible" THEN "rs"."total_points"
            ELSE ("rs"."total_points" - "rs"."points_deduction")
        END AS "total_points"
   FROM ("public"."race_scores" "rs"
     CROSS JOIN LATERAL ( SELECT (( SELECT "public"."is_admin"() AS "is_admin") OR (EXISTS ( SELECT 1
                   FROM "public"."round_incident_status" "s"
                  WHERE (("s"."subsession_id" = "rs"."subsession_id") AND "s"."posted")))) AS "penalties_visible") "v");


ALTER VIEW "public"."race_scores_public" OWNER TO "postgres";


COMMENT ON VIEW "public"."race_scores_public" IS 'race_scores for public pages: every row, but an unposted round''s penalty deduction is removed (0112).';



CREATE TABLE IF NOT EXISTS "public"."round_overrides" (
    "subsession_id" bigint NOT NULL,
    "is_exhibition" boolean DEFAULT true NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_test" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."round_overrides" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."round_penalties" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "subsession_id" bigint NOT NULL,
    "driver_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "note" "text",
    "served_subsession_id" bigint,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "round_penalties_check" CHECK ((("kind" <> 'other'::"text") OR ("note" IS NOT NULL))),
    CONSTRAINT "round_penalties_kind_check" CHECK (("kind" = ANY (ARRAY['qualifying_ban'::"text", 'pit_lane_start'::"text", 'race_ban'::"text", 'round_ban'::"text", 'other'::"text"]))),
    CONSTRAINT "round_penalties_note_check" CHECK ((("note" IS NULL) OR ("length"("note") <= 500)))
);


ALTER TABLE "public"."round_penalties" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scoring_rulesets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "rules" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "can_drop_final_round" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."scoring_rulesets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."seasons" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "number" integer NOT NULL,
    "name" "text" NOT NULL,
    "logo_url" "text",
    "start_date" "date",
    "end_date" "date",
    "is_current" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "iracing_season_id" bigint,
    "scoring_ruleset_id" "uuid",
    "extra_drop_weeks" integer DEFAULT 0 NOT NULL,
    "standings_locked_at" timestamp with time zone,
    "gamma_enabled" boolean DEFAULT false NOT NULL,
    "delta_enabled" boolean DEFAULT false NOT NULL,
    "delta_team_enabled" boolean DEFAULT false NOT NULL,
    "logo_url_light" "text",
    CONSTRAINT "seasons_extra_drop_weeks_check" CHECK (("extra_drop_weeks" >= 0))
);


ALTER TABLE "public"."seasons" OWNER TO "postgres";


COMMENT ON COLUMN "public"."seasons"."iracing_season_id" IS 'iRacing season identifier; canonical key for linking curated_rounds to a season row.';



COMMENT ON COLUMN "public"."seasons"."gamma_enabled" IS 'Whether the Gamma class competed this season — controls whether Gamma standings/champions/tabs show for this season on the public site. Gamma did not exist before ATC16.';



COMMENT ON COLUMN "public"."seasons"."delta_enabled" IS 'Whether the Delta class competed this season — controls whether Delta standings/champions/tabs show for this season on the public site. Delta did not exist before ATC5.';



COMMENT ON COLUMN "public"."seasons"."delta_team_enabled" IS 'Whether the separate Delta TEAM championship (distinct from the Delta driver class — see delta_enabled) ran this season. The Delta class itself existed from ATC5, but the standalone Delta Team competition/standings only began at ATC10. Controls whether Delta Team standings/champions show for this season on the public site.';



CREATE TABLE IF NOT EXISTS "public"."signup_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "discord_user_id" "text" NOT NULL,
    "discord_username" "text",
    "name" "text" NOT NULL,
    "iracing_cust_id" bigint,
    "requested_numbers" integer[] NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reason" "text",
    "driver_id" "uuid",
    "decided_by" "uuid",
    "decided_at" timestamp with time zone,
    "notified_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "signup_requests_discord_user_id_check" CHECK (("discord_user_id" ~ '^[0-9]{1,25}$'::"text")),
    CONSTRAINT "signup_requests_iracing_cust_id_check" CHECK ((("iracing_cust_id" IS NULL) OR ("iracing_cust_id" > 0))),
    CONSTRAINT "signup_requests_name_check" CHECK ((("length"("btrim"("name")) >= 1) AND ("length"("btrim"("name")) <= 80))),
    CONSTRAINT "signup_requests_reason_check" CHECK ((("reason" IS NULL) OR ("length"("reason") <= 500))),
    CONSTRAINT "signup_requests_requested_numbers_check" CHECK (((("cardinality"("requested_numbers") >= 1) AND ("cardinality"("requested_numbers") <= 3)) AND (0 <= ALL ("requested_numbers")) AND (999 >= ALL ("requested_numbers")))),
    CONSTRAINT "signup_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."signup_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."site_settings" (
    "setting_key" "text" NOT NULL,
    "value" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."site_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."team_rosters" (
    "season_id" "uuid" NOT NULL,
    "team_id" "uuid" NOT NULL,
    "driver_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."team_rosters" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."team_season_logos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "team_id" "uuid" NOT NULL,
    "season_id" "uuid" NOT NULL,
    "logo_url" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."team_season_logos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."teams" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "primary_color_hex" "text",
    "logo_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    CONSTRAINT "teams_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'inactive'::"text"])))
);


ALTER TABLE "public"."teams" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."track_guides" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "layout_id" "uuid" NOT NULL,
    "title" "text",
    "url" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."track_guides" OWNER TO "postgres";


COMMENT ON TABLE "public"."track_guides" IS 'One or more YouTube track guide videos per circuit_layouts row — replaces the old single circuit_layouts.track_guide_url column (see this migration). Shown grouped by layout on the public Media page''s Track Guide filter and managed per-layout on the admin Circuits page.';



ALTER TABLE ONLY "public"."driver_classes" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."driver_classes_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."driver_statuses" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."driver_statuses_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."activity_log"
    ADD CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."car_logos"
    ADD CONSTRAINT "car_logos_pkey" PRIMARY KEY ("car_name");



ALTER TABLE ONLY "public"."champion_photos"
    ADD CONSTRAINT "champion_photos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."champion_photos"
    ADD CONSTRAINT "champion_photos_unique_slot" UNIQUE ("season_id", "class_id", "sort_order");



ALTER TABLE ONLY "public"."circuit_layouts"
    ADD CONSTRAINT "circuit_layouts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."circuits"
    ADD CONSTRAINT "circuits_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."circuits"
    ADD CONSTRAINT "circuits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."curated_qualifying"
    ADD CONSTRAINT "curated_qualifying_pkey" PRIMARY KEY ("subsession_id", "cust_id");



ALTER TABLE ONLY "public"."curated_race_results"
    ADD CONSTRAINT "curated_race_results_pkey" PRIMARY KEY ("subsession_id", "race_number", "cust_id");



ALTER TABLE ONLY "public"."curated_rounds"
    ADD CONSTRAINT "curated_rounds_pkey" PRIMARY KEY ("subsession_id");



ALTER TABLE ONLY "public"."driver_classes"
    ADD CONSTRAINT "driver_classes_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."driver_classes"
    ADD CONSTRAINT "driver_classes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."driver_season_car_numbers"
    ADD CONSTRAINT "driver_season_car_numbers_pkey" PRIMARY KEY ("driver_id", "season_id");



ALTER TABLE ONLY "public"."driver_season_car_numbers"
    ADD CONSTRAINT "driver_season_car_numbers_season_id_car_number_key" UNIQUE ("season_id", "car_number");



ALTER TABLE ONLY "public"."driver_season_classes"
    ADD CONSTRAINT "driver_season_classes_pkey" PRIMARY KEY ("driver_id", "season_id");



ALTER TABLE ONLY "public"."driver_statuses"
    ADD CONSTRAINT "driver_statuses_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."driver_statuses"
    ADD CONSTRAINT "driver_statuses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."drivers"
    ADD CONSTRAINT "drivers_iracing_cust_id_key" UNIQUE ("iracing_cust_id");



ALTER TABLE ONLY "public"."drivers"
    ADD CONSTRAINT "drivers_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."drivers"
    ADD CONSTRAINT "drivers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hall_of_fame_photos"
    ADD CONSTRAINT "hall_of_fame_photos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hall_of_fame_photos"
    ADD CONSTRAINT "hall_of_fame_photos_unique_slot" UNIQUE ("driver_id", "sort_order");



ALTER TABLE ONLY "public"."incident_appeals"
    ADD CONSTRAINT "incident_appeals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."incident_report_drivers"
    ADD CONSTRAINT "incident_report_drivers_pkey" PRIMARY KEY ("report_id", "driver_id");



ALTER TABLE ONLY "public"."incident_report_review_drivers"
    ADD CONSTRAINT "incident_report_review_drivers_pkey" PRIMARY KEY ("review_id", "driver_id");



ALTER TABLE ONLY "public"."incident_report_reviews"
    ADD CONSTRAINT "incident_report_reviews_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."incident_report_reviews"
    ADD CONSTRAINT "incident_report_reviews_report_id_reviewer_id_key" UNIQUE ("report_id", "reviewer_id");



ALTER TABLE ONLY "public"."incident_reports"
    ADD CONSTRAINT "incident_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kudos_drivers"
    ADD CONSTRAINT "kudos_drivers_pkey" PRIMARY KEY ("kudos_id", "driver_id");



ALTER TABLE ONLY "public"."kudos"
    ADD CONSTRAINT "kudos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."layout_corners"
    ADD CONSTRAINT "layout_corners_layout_id_label_key" UNIQUE ("layout_id", "label");



ALTER TABLE ONLY "public"."layout_corners"
    ADD CONSTRAINT "layout_corners_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."layout_incident_pins"
    ADD CONSTRAINT "layout_incident_pins_penalty_id_key" UNIQUE ("penalty_id");



ALTER TABLE ONLY "public"."layout_incident_pins"
    ADD CONSTRAINT "layout_incident_pins_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."manual_awards"
    ADD CONSTRAINT "manual_awards_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."manual_awards"
    ADD CONSTRAINT "manual_awards_unique_winner" UNIQUE ("season_id", "award_key", "driver_id");



ALTER TABLE ONLY "public"."manual_result_imports"
    ADD CONSTRAINT "manual_result_imports_pkey" PRIMARY KEY ("import_key");



ALTER TABLE ONLY "public"."manual_result_imports"
    ADD CONSTRAINT "manual_result_imports_subsession_id_key" UNIQUE ("subsession_id");



ALTER TABLE ONLY "public"."media_graphics"
    ADD CONSTRAINT "media_graphics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."media_meetup_drivers"
    ADD CONSTRAINT "media_meetup_drivers_pkey" PRIMARY KEY ("meetup_id", "driver_id");



ALTER TABLE ONLY "public"."media_meetups"
    ADD CONSTRAINT "media_meetups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."media_videos"
    ADD CONSTRAINT "media_videos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."news_post_drivers"
    ADD CONSTRAINT "news_post_drivers_pkey" PRIMARY KEY ("post_id", "driver_id");



ALTER TABLE ONLY "public"."news_post_tags"
    ADD CONSTRAINT "news_post_tags_pkey" PRIMARY KEY ("post_id", "tag_id");



ALTER TABLE ONLY "public"."news_posts"
    ADD CONSTRAINT "news_posts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."news_posts"
    ADD CONSTRAINT "news_posts_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."news_tags"
    ADD CONSTRAINT "news_tags_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."news_tags"
    ADD CONSTRAINT "news_tags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organization_team_seasons"
    ADD CONSTRAINT "organization_team_seasons_one_org_per_team_season" UNIQUE ("team_id", "season_id");



ALTER TABLE ONLY "public"."organization_team_seasons"
    ADD CONSTRAINT "organization_team_seasons_one_team_per_org_season" UNIQUE ("organization_id", "season_id");



ALTER TABLE ONLY "public"."organization_team_seasons"
    ADD CONSTRAINT "organization_team_seasons_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."page_banners"
    ADD CONSTRAINT "page_banners_pkey" PRIMARY KEY ("page_key");



ALTER TABLE ONLY "public"."page_views"
    ADD CONSTRAINT "page_views_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."penalties"
    ADD CONSTRAINT "penalties_pkey1" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."penalty_involved_drivers"
    ADD CONSTRAINT "penalty_involved_drivers_pkey" PRIMARY KEY ("penalty_id", "driver_id");



ALTER TABLE ONLY "public"."penalty_offense_links"
    ADD CONSTRAINT "penalty_offense_links_pkey" PRIMARY KEY ("penalty_id", "offense_id");



ALTER TABLE ONLY "public"."penalty_offenses"
    ADD CONSTRAINT "penalty_offenses_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."penalty_offenses"
    ADD CONSTRAINT "penalty_offenses_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."profiles"
    ADD CONSTRAINT "profiles_display_name_len" CHECK ((("display_name" IS NULL) OR ("char_length"("display_name") <= 80))) NOT VALID;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_iracing_cust_id_key" UNIQUE ("iracing_cust_id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."race_interviews"
    ADD CONSTRAINT "race_interviews_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."race_links"
    ADD CONSTRAINT "race_links_pkey" PRIMARY KEY ("subsession_id", "race_number");



ALTER TABLE ONLY "public"."race_scores"
    ADD CONSTRAINT "race_scores_pkey" PRIMARY KEY ("subsession_id", "race_number", "driver_id");



ALTER TABLE ONLY "public"."round_incident_status"
    ADD CONSTRAINT "round_incident_status_pkey" PRIMARY KEY ("subsession_id");



ALTER TABLE ONLY "public"."round_overrides"
    ADD CONSTRAINT "round_overrides_pkey" PRIMARY KEY ("subsession_id");



ALTER TABLE ONLY "public"."round_penalties"
    ADD CONSTRAINT "round_penalties_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scoring_rulesets"
    ADD CONSTRAINT "scoring_rulesets_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."scoring_rulesets"
    ADD CONSTRAINT "scoring_rulesets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."seasons"
    ADD CONSTRAINT "seasons_number_key" UNIQUE ("number");



ALTER TABLE ONLY "public"."seasons"
    ADD CONSTRAINT "seasons_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."signup_requests"
    ADD CONSTRAINT "signup_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."site_settings"
    ADD CONSTRAINT "site_settings_pkey" PRIMARY KEY ("setting_key");



ALTER TABLE ONLY "public"."team_rosters"
    ADD CONSTRAINT "team_rosters_pkey" PRIMARY KEY ("season_id", "team_id", "driver_id");



ALTER TABLE ONLY "public"."team_season_logos"
    ADD CONSTRAINT "team_season_logos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."team_season_logos"
    ADD CONSTRAINT "team_season_logos_team_id_season_id_key" UNIQUE ("team_id", "season_id");



ALTER TABLE ONLY "public"."teams"
    ADD CONSTRAINT "teams_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."teams"
    ADD CONSTRAINT "teams_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."track_guides"
    ADD CONSTRAINT "track_guides_pkey" PRIMARY KEY ("id");



CREATE INDEX "activity_log_action_idx" ON "public"."activity_log" USING "btree" ("action");



CREATE INDEX "activity_log_actor_id_idx" ON "public"."activity_log" USING "btree" ("actor_id");



CREATE INDEX "activity_log_created_at_idx" ON "public"."activity_log" USING "btree" ("created_at" DESC);



CREATE INDEX "activity_log_entity_type_idx" ON "public"."activity_log" USING "btree" ("entity_type");



CREATE INDEX "champion_photos_class_id_idx" ON "public"."champion_photos" USING "btree" ("class_id");



CREATE INDEX "champion_photos_driver_id_idx" ON "public"."champion_photos" USING "btree" ("driver_id");



CREATE INDEX "champion_photos_lookup_idx" ON "public"."champion_photos" USING "btree" ("season_id", "class_id");



CREATE INDEX "circuit_layouts_circuit_idx" ON "public"."circuit_layouts" USING "btree" ("circuit_id");



CREATE INDEX "curated_practice_results_subsession_id_idx" ON "public"."curated_practice_results" USING "btree" ("subsession_id");



CREATE INDEX "curated_qualifying_cust_idx" ON "public"."curated_qualifying" USING "btree" ("cust_id");



CREATE INDEX "curated_race_results_cust_idx" ON "public"."curated_race_results" USING "btree" ("cust_id");



CREATE INDEX "curated_race_results_round_idx" ON "public"."curated_race_results" USING "btree" ("subsession_id", "race_number");



CREATE INDEX "curated_rounds_event_id_idx" ON "public"."curated_rounds" USING "btree" ("event_id");



CREATE UNIQUE INDEX "curated_rounds_event_id_unique_idx" ON "public"."curated_rounds" USING "btree" ("event_id") WHERE ("event_id" IS NOT NULL);



CREATE INDEX "curated_rounds_official_start_time_idx" ON "public"."curated_rounds" USING "btree" ("start_time") WHERE ("status" = 'official'::"text");



CREATE INDEX "curated_rounds_season_idx" ON "public"."curated_rounds" USING "btree" ("season_id");



CREATE UNIQUE INDEX "curated_rounds_season_round_idx" ON "public"."curated_rounds" USING "btree" ("season_id", "round_number") WHERE (("season_id" IS NOT NULL) AND ("round_number" IS NOT NULL));



CREATE INDEX "curated_rounds_start_time_idx" ON "public"."curated_rounds" USING "btree" ("start_time" DESC);



CREATE INDEX "curated_rounds_status_idx" ON "public"."curated_rounds" USING "btree" ("status");



CREATE INDEX "driver_season_classes_class_id_idx" ON "public"."driver_season_classes" USING "btree" ("class_id");



CREATE INDEX "driver_season_classes_season_id_idx" ON "public"."driver_season_classes" USING "btree" ("season_id");



CREATE UNIQUE INDEX "drivers_car_number_unique_idx" ON "public"."drivers" USING "btree" ("car_number") WHERE ("car_number" IS NOT NULL);



CREATE INDEX "drivers_class_idx" ON "public"."drivers" USING "btree" ("class_id");



CREATE INDEX "drivers_created_by_idx" ON "public"."drivers" USING "btree" ("created_by");



CREATE UNIQUE INDEX "drivers_iracing_cust_id_idx" ON "public"."drivers" USING "btree" ("iracing_cust_id") WHERE ("iracing_cust_id" IS NOT NULL);



CREATE INDEX "drivers_status_idx" ON "public"."drivers" USING "btree" ("status_id");



CREATE INDEX "drivers_team_idx" ON "public"."drivers" USING "btree" ("team_id");



CREATE INDEX "drivers_updated_by_idx" ON "public"."drivers" USING "btree" ("updated_by");



CREATE INDEX "events_circuit_idx" ON "public"."events" USING "btree" ("circuit_id");



CREATE INDEX "events_date_idx" ON "public"."events" USING "btree" ("event_date");



CREATE INDEX "events_season_round_idx" ON "public"."events" USING "btree" ("season_id", "round_number") WHERE ("season_id" IS NOT NULL);



CREATE INDEX "events_subsession_id_idx" ON "public"."events" USING "btree" ("subsession_id");



CREATE INDEX "hall_of_fame_photos_driver_idx" ON "public"."hall_of_fame_photos" USING "btree" ("driver_id");



CREATE INDEX "incident_appeals_penalty_idx" ON "public"."incident_appeals" USING "btree" ("penalty_id");



CREATE INDEX "incident_appeals_subsession_idx" ON "public"."incident_appeals" USING "btree" ("subsession_id");



CREATE INDEX "incident_report_drivers_driver_idx" ON "public"."incident_report_drivers" USING "btree" ("driver_id");



CREATE INDEX "incident_report_reviews_report_idx" ON "public"."incident_report_reviews" USING "btree" ("report_id");



CREATE INDEX "incident_reports_reporter_idx" ON "public"."incident_reports" USING "btree" ("reporter_id");



CREATE INDEX "incident_reports_subsession_idx" ON "public"."incident_reports" USING "btree" ("subsession_id");



CREATE INDEX "kudos_author_idx" ON "public"."kudos" USING "btree" ("author_id");



CREATE INDEX "kudos_drivers_driver_idx" ON "public"."kudos_drivers" USING "btree" ("driver_id");



CREATE INDEX "kudos_subsession_idx" ON "public"."kudos" USING "btree" ("subsession_id");



CREATE INDEX "layout_corners_layout_id_idx" ON "public"."layout_corners" USING "btree" ("layout_id");



CREATE INDEX "layout_incident_pins_layout_id_idx" ON "public"."layout_incident_pins" USING "btree" ("layout_id");



CREATE INDEX "manual_awards_driver_id_idx" ON "public"."manual_awards" USING "btree" ("driver_id");



CREATE INDEX "manual_awards_season_award_idx" ON "public"."manual_awards" USING "btree" ("season_id", "award_key");



CREATE INDEX "manual_awards_season_idx" ON "public"."manual_awards" USING "btree" ("season_id");



CREATE INDEX "media_graphics_created_idx" ON "public"."media_graphics" USING "btree" ("created_at" DESC);



CREATE INDEX "media_meetup_drivers_driver_idx" ON "public"."media_meetup_drivers" USING "btree" ("driver_id");



CREATE INDEX "media_meetups_created_idx" ON "public"."media_meetups" USING "btree" ("created_at" DESC);



CREATE INDEX "media_videos_category_idx" ON "public"."media_videos" USING "btree" ("category", "created_at" DESC);



CREATE INDEX "news_post_drivers_driver_idx" ON "public"."news_post_drivers" USING "btree" ("driver_id");



CREATE INDEX "news_post_tags_tag_id_idx" ON "public"."news_post_tags" USING "btree" ("tag_id");



CREATE INDEX "news_posts_published_idx" ON "public"."news_posts" USING "btree" ("published_at" DESC) WHERE ("status" = 'published'::"text");



CREATE INDEX "news_posts_round_subsession_idx" ON "public"."news_posts" USING "btree" ("round_subsession_id");



CREATE INDEX "news_posts_season_id_idx" ON "public"."news_posts" USING "btree" ("season_id");



CREATE INDEX "news_posts_season_label_idx" ON "public"."news_posts" USING "btree" ("season_label");



CREATE UNIQUE INDEX "one_current_season" ON "public"."seasons" USING "btree" ("is_current") WHERE "is_current";



CREATE INDEX "organization_team_seasons_org_idx" ON "public"."organization_team_seasons" USING "btree" ("organization_id");



CREATE INDEX "organization_team_seasons_season_idx" ON "public"."organization_team_seasons" USING "btree" ("season_id");



CREATE INDEX "organization_team_seasons_team_idx" ON "public"."organization_team_seasons" USING "btree" ("team_id");



CREATE INDEX "page_views_status_idx" ON "public"."page_views" USING "btree" ("status") WHERE ("status" >= 400);



CREATE INDEX "page_views_viewed_at_idx" ON "public"."page_views" USING "btree" ("viewed_at");



CREATE INDEX "page_views_visitor_hash_idx" ON "public"."page_views" USING "btree" ("visitor_hash");



CREATE INDEX "page_views_visitor_hash_viewed_at_idx" ON "public"."page_views" USING "btree" ("visitor_hash", "viewed_at");



CREATE INDEX "penalties_driver_idx" ON "public"."penalties" USING "btree" ("driver_id");



CREATE INDEX "penalty_involved_drivers_driver_id_idx" ON "public"."penalty_involved_drivers" USING "btree" ("driver_id");



CREATE INDEX "penalty_offense_links_offense_id_idx" ON "public"."penalty_offense_links" USING "btree" ("offense_id");



CREATE INDEX "profiles_driver_id_idx" ON "public"."profiles" USING "btree" ("driver_id");



CREATE INDEX "race_interviews_driver_idx" ON "public"."race_interviews" USING "btree" ("driver_id");



CREATE UNIQUE INDEX "race_interviews_one_per_driver_round" ON "public"."race_interviews" USING "btree" ("subsession_id", "driver_id");



CREATE INDEX "race_interviews_subsession_idx" ON "public"."race_interviews" USING "btree" ("subsession_id");



CREATE INDEX "race_scores_class_id_idx" ON "public"."race_scores" USING "btree" ("class_id");



CREATE INDEX "race_scores_driver_idx" ON "public"."race_scores" USING "btree" ("driver_id");



CREATE INDEX "race_scores_round_idx" ON "public"."race_scores" USING "btree" ("subsession_id", "race_number");



CREATE INDEX "race_scores_season_idx" ON "public"."race_scores" USING "btree" ("season_id");



CREATE INDEX "race_scores_team_id_idx" ON "public"."race_scores" USING "btree" ("team_id");



CREATE INDEX "round_penalties_driver_idx" ON "public"."round_penalties" USING "btree" ("driver_id");



CREATE INDEX "round_penalties_owed_idx" ON "public"."round_penalties" USING "btree" ("subsession_id") WHERE ("served_subsession_id" IS NULL);



CREATE INDEX "round_penalties_subsession_idx" ON "public"."round_penalties" USING "btree" ("subsession_id");



CREATE UNIQUE INDEX "scoring_rulesets_one_default" ON "public"."scoring_rulesets" USING "btree" ("is_default") WHERE "is_default";



CREATE UNIQUE INDEX "seasons_iracing_season_id_idx" ON "public"."seasons" USING "btree" ("iracing_season_id") WHERE ("iracing_season_id" IS NOT NULL);



CREATE UNIQUE INDEX "signup_requests_one_pending_per_user" ON "public"."signup_requests" USING "btree" ("discord_user_id") WHERE ("status" = 'pending'::"text");



CREATE INDEX "signup_requests_status_idx" ON "public"."signup_requests" USING "btree" ("status", "created_at");



CREATE INDEX "team_rosters_driver_id_idx" ON "public"."team_rosters" USING "btree" ("driver_id");



CREATE INDEX "team_rosters_season_idx" ON "public"."team_rosters" USING "btree" ("season_id");



CREATE INDEX "team_rosters_team_idx" ON "public"."team_rosters" USING "btree" ("team_id");



CREATE INDEX "team_season_logos_season_idx" ON "public"."team_season_logos" USING "btree" ("season_id");



CREATE INDEX "team_season_logos_team_idx" ON "public"."team_season_logos" USING "btree" ("team_id");



CREATE INDEX "track_guides_layout_id_idx" ON "public"."track_guides" USING "btree" ("layout_id");



CREATE OR REPLACE TRIGGER "car_logos_set_updated_at" BEFORE UPDATE ON "public"."car_logos" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "champion_photos_set_updated_at" BEFORE UPDATE ON "public"."champion_photos" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "circuit_layouts_set_updated_at" BEFORE UPDATE ON "public"."circuit_layouts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "circuits_set_updated_at" BEFORE UPDATE ON "public"."circuits" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "curated_qualifying_set_updated_at" BEFORE UPDATE ON "public"."curated_qualifying" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "curated_race_results_set_updated_at" BEFORE UPDATE ON "public"."curated_race_results" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "curated_rounds_set_updated_at" BEFORE UPDATE ON "public"."curated_rounds" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "drivers_set_audit_fields" BEFORE INSERT OR UPDATE ON "public"."drivers" FOR EACH ROW EXECUTE FUNCTION "public"."set_driver_audit_fields"();



CREATE OR REPLACE TRIGGER "drivers_set_updated_at" BEFORE UPDATE ON "public"."drivers" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "events_set_updated_at" BEFORE UPDATE ON "public"."events" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "hall_of_fame_photos_set_updated_at" BEFORE UPDATE ON "public"."hall_of_fame_photos" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "incident_reports_clear_dismissal_reason" BEFORE INSERT OR UPDATE ON "public"."incident_reports" FOR EACH ROW EXECUTE FUNCTION "public"."clear_incident_report_dismissal_reason"();



CREATE OR REPLACE TRIGGER "incident_reports_stamp_reviews_closed" BEFORE UPDATE ON "public"."incident_reports" FOR EACH ROW EXECUTE FUNCTION "public"."stamp_incident_report_reviews_closed"();



CREATE OR REPLACE TRIGGER "manual_result_imports_set_updated_at" BEFORE UPDATE ON "public"."manual_result_imports" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "news_posts_set_updated_at" BEFORE UPDATE ON "public"."news_posts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "organizations_set_updated_at" BEFORE UPDATE ON "public"."organizations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "page_banners_set_updated_at" BEFORE UPDATE ON "public"."page_banners" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "penalties_set_updated_at" BEFORE UPDATE ON "public"."penalties" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "profiles_prevent_role_self_escalation" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_role_self_escalation"();



CREATE OR REPLACE TRIGGER "profiles_set_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "race_links_set_updated_at" BEFORE UPDATE ON "public"."race_links" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "round_incident_status_set_updated_at" BEFORE UPDATE ON "public"."round_incident_status" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "round_overrides_set_updated_at" BEFORE UPDATE ON "public"."round_overrides" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "scoring_rulesets_set_updated_at" BEFORE UPDATE ON "public"."scoring_rulesets" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "site_settings_set_updated_at" BEFORE UPDATE ON "public"."site_settings" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "team_rosters_enforce_limits" BEFORE INSERT ON "public"."team_rosters" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_team_roster_limits"();



CREATE OR REPLACE TRIGGER "team_season_logos_set_updated_at" BEFORE UPDATE ON "public"."team_season_logos" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "teams_set_updated_at" BEFORE UPDATE ON "public"."teams" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



ALTER TABLE ONLY "public"."activity_log"
    ADD CONSTRAINT "activity_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."champion_photos"
    ADD CONSTRAINT "champion_photos_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."driver_classes"("id");



ALTER TABLE ONLY "public"."champion_photos"
    ADD CONSTRAINT "champion_photos_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."champion_photos"
    ADD CONSTRAINT "champion_photos_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."circuit_layouts"
    ADD CONSTRAINT "circuit_layouts_circuit_id_fkey" FOREIGN KEY ("circuit_id") REFERENCES "public"."circuits"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."curated_qualifying"
    ADD CONSTRAINT "curated_qualifying_subsession_id_fkey" FOREIGN KEY ("subsession_id") REFERENCES "public"."curated_rounds"("subsession_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."curated_race_results"
    ADD CONSTRAINT "curated_race_results_subsession_id_fkey" FOREIGN KEY ("subsession_id") REFERENCES "public"."curated_rounds"("subsession_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."curated_rounds"
    ADD CONSTRAINT "curated_rounds_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."curated_rounds"
    ADD CONSTRAINT "curated_rounds_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."driver_season_car_numbers"
    ADD CONSTRAINT "driver_season_car_numbers_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."driver_season_car_numbers"
    ADD CONSTRAINT "driver_season_car_numbers_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."driver_season_classes"
    ADD CONSTRAINT "driver_season_classes_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."driver_classes"("id");



ALTER TABLE ONLY "public"."driver_season_classes"
    ADD CONSTRAINT "driver_season_classes_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."driver_season_classes"
    ADD CONSTRAINT "driver_season_classes_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drivers"
    ADD CONSTRAINT "drivers_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."driver_classes"("id");



ALTER TABLE ONLY "public"."drivers"
    ADD CONSTRAINT "drivers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."drivers"
    ADD CONSTRAINT "drivers_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "public"."driver_statuses"("id");



ALTER TABLE ONLY "public"."drivers"
    ADD CONSTRAINT "drivers_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."drivers"
    ADD CONSTRAINT "drivers_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_circuit_id_fkey" FOREIGN KEY ("circuit_id") REFERENCES "public"."circuits"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id");



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_subsession_id_fkey" FOREIGN KEY ("subsession_id") REFERENCES "public"."curated_rounds"("subsession_id");



ALTER TABLE ONLY "public"."hall_of_fame_photos"
    ADD CONSTRAINT "hall_of_fame_photos_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."incident_appeals"
    ADD CONSTRAINT "incident_appeals_penalty_id_fkey" FOREIGN KEY ("penalty_id") REFERENCES "public"."penalties"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."incident_appeals"
    ADD CONSTRAINT "incident_appeals_submitter_id_fkey" FOREIGN KEY ("submitter_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."incident_report_drivers"
    ADD CONSTRAINT "incident_report_drivers_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."incident_report_drivers"
    ADD CONSTRAINT "incident_report_drivers_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "public"."incident_reports"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."incident_report_review_drivers"
    ADD CONSTRAINT "incident_report_review_drivers_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."incident_report_review_drivers"
    ADD CONSTRAINT "incident_report_review_drivers_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "public"."incident_report_reviews"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."incident_report_reviews"
    ADD CONSTRAINT "incident_report_reviews_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "public"."incident_reports"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."incident_report_reviews"
    ADD CONSTRAINT "incident_report_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."incident_reports"
    ADD CONSTRAINT "incident_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."kudos"
    ADD CONSTRAINT "kudos_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."kudos_drivers"
    ADD CONSTRAINT "kudos_drivers_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."kudos_drivers"
    ADD CONSTRAINT "kudos_drivers_kudos_id_fkey" FOREIGN KEY ("kudos_id") REFERENCES "public"."kudos"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."layout_corners"
    ADD CONSTRAINT "layout_corners_layout_id_fkey" FOREIGN KEY ("layout_id") REFERENCES "public"."circuit_layouts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."layout_incident_pins"
    ADD CONSTRAINT "layout_incident_pins_layout_id_fkey" FOREIGN KEY ("layout_id") REFERENCES "public"."circuit_layouts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."layout_incident_pins"
    ADD CONSTRAINT "layout_incident_pins_penalty_id_fkey" FOREIGN KEY ("penalty_id") REFERENCES "public"."penalties"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."manual_awards"
    ADD CONSTRAINT "manual_awards_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."manual_awards"
    ADD CONSTRAINT "manual_awards_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."media_meetup_drivers"
    ADD CONSTRAINT "media_meetup_drivers_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."media_meetup_drivers"
    ADD CONSTRAINT "media_meetup_drivers_meetup_id_fkey" FOREIGN KEY ("meetup_id") REFERENCES "public"."media_meetups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."news_post_drivers"
    ADD CONSTRAINT "news_post_drivers_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."news_post_drivers"
    ADD CONSTRAINT "news_post_drivers_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."news_posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."news_post_tags"
    ADD CONSTRAINT "news_post_tags_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."news_posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."news_post_tags"
    ADD CONSTRAINT "news_post_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."news_tags"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."news_posts"
    ADD CONSTRAINT "news_posts_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."organization_team_seasons"
    ADD CONSTRAINT "organization_team_seasons_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_team_seasons"
    ADD CONSTRAINT "organization_team_seasons_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_team_seasons"
    ADD CONSTRAINT "organization_team_seasons_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."penalties"
    ADD CONSTRAINT "penalties_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."penalty_involved_drivers"
    ADD CONSTRAINT "penalty_involved_drivers_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."penalty_involved_drivers"
    ADD CONSTRAINT "penalty_involved_drivers_penalty_id_fkey" FOREIGN KEY ("penalty_id") REFERENCES "public"."penalties"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."penalty_offense_links"
    ADD CONSTRAINT "penalty_offense_links_offense_id_fkey" FOREIGN KEY ("offense_id") REFERENCES "public"."penalty_offenses"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."penalty_offense_links"
    ADD CONSTRAINT "penalty_offense_links_penalty_id_fkey" FOREIGN KEY ("penalty_id") REFERENCES "public"."penalties"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."race_interviews"
    ADD CONSTRAINT "race_interviews_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."race_interviews"
    ADD CONSTRAINT "race_interviews_submitter_id_fkey" FOREIGN KEY ("submitter_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."race_scores"
    ADD CONSTRAINT "race_scores_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."driver_classes"("id");



ALTER TABLE ONLY "public"."race_scores"
    ADD CONSTRAINT "race_scores_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."race_scores"
    ADD CONSTRAINT "race_scores_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."race_scores"
    ADD CONSTRAINT "race_scores_subsession_id_fkey" FOREIGN KEY ("subsession_id") REFERENCES "public"."curated_rounds"("subsession_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."race_scores"
    ADD CONSTRAINT "race_scores_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."round_penalties"
    ADD CONSTRAINT "round_penalties_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."round_penalties"
    ADD CONSTRAINT "round_penalties_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."signup_requests"
    ADD CONSTRAINT "signup_requests_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."signup_requests"
    ADD CONSTRAINT "signup_requests_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."team_rosters"
    ADD CONSTRAINT "team_rosters_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."team_rosters"
    ADD CONSTRAINT "team_rosters_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."team_rosters"
    ADD CONSTRAINT "team_rosters_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."team_season_logos"
    ADD CONSTRAINT "team_season_logos_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."team_season_logos"
    ADD CONSTRAINT "team_season_logos_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."track_guides"
    ADD CONSTRAINT "track_guides_layout_id_fkey" FOREIGN KEY ("layout_id") REFERENCES "public"."circuit_layouts"("id") ON DELETE CASCADE;



ALTER TABLE "public"."activity_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "admin delete car_logos" ON "public"."car_logos" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete champion_photos" ON "public"."champion_photos" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete circuit_layouts" ON "public"."circuit_layouts" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete circuits" ON "public"."circuits" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete curated_race_results" ON "public"."curated_race_results" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete curated_rounds" ON "public"."curated_rounds" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete driver_season_car_numbers" ON "public"."driver_season_car_numbers" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete driver_season_classes" ON "public"."driver_season_classes" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete drivers" ON "public"."drivers" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete events" ON "public"."events" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete hall_of_fame_photos" ON "public"."hall_of_fame_photos" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete incident_appeals" ON "public"."incident_appeals" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete incident_report_drivers" ON "public"."incident_report_drivers" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete incident_reports" ON "public"."incident_reports" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete layout_corners" ON "public"."layout_corners" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete layout_incident_pins" ON "public"."layout_incident_pins" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete manual_awards" ON "public"."manual_awards" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete manual_result_imports" ON "public"."manual_result_imports" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete media_graphics" ON "public"."media_graphics" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete media_meetup_drivers" ON "public"."media_meetup_drivers" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete media_meetups" ON "public"."media_meetups" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete media_videos" ON "public"."media_videos" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete news" ON "public"."news_posts" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete news_post_drivers" ON "public"."news_post_drivers" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete news_post_tags" ON "public"."news_post_tags" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete news_tags" ON "public"."news_tags" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete organization_team_seasons" ON "public"."organization_team_seasons" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete organizations" ON "public"."organizations" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete page_banners" ON "public"."page_banners" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete penalties" ON "public"."penalties" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete penalty_involved_drivers" ON "public"."penalty_involved_drivers" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete penalty_offense_links" ON "public"."penalty_offense_links" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete penalty_offenses" ON "public"."penalty_offenses" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete practice results" ON "public"."curated_practice_results" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete qualifying" ON "public"."curated_qualifying" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete race_interviews" ON "public"."race_interviews" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete race_links" ON "public"."race_links" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete race_scores" ON "public"."race_scores" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete round_incident_status" ON "public"."round_incident_status" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete round_overrides" ON "public"."round_overrides" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete round_penalties" ON "public"."round_penalties" FOR DELETE USING (( SELECT "public"."is_admin"() AS "is_admin"));



CREATE POLICY "admin delete rulesets" ON "public"."scoring_rulesets" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete site_settings" ON "public"."site_settings" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete team_rosters" ON "public"."team_rosters" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete team_season_logos" ON "public"."team_season_logos" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete teams" ON "public"."teams" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin delete track_guides" ON "public"."track_guides" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "admin insert layout_corners" ON "public"."layout_corners" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin insert layout_incident_pins" ON "public"."layout_incident_pins" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin insert practice results" ON "public"."curated_practice_results" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin insert profiles" ON "public"."profiles" FOR INSERT WITH CHECK (("public"."is_admin"() OR ((( SELECT "auth"."uid"() AS "uid") = "id") AND ("role" = 'driver'::"text") AND ("driver_id" IS NULL) AND ("iracing_cust_id" IS NULL) AND ("iracing_name" IS NULL))));



CREATE POLICY "admin insert qualifying" ON "public"."curated_qualifying" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin insert round_incident_status" ON "public"."round_incident_status" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin insert round_penalties" ON "public"."round_penalties" FOR INSERT WITH CHECK (( SELECT "public"."is_admin"() AS "is_admin"));



CREATE POLICY "admin insert rulesets" ON "public"."scoring_rulesets" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin read activity_log" ON "public"."activity_log" FOR SELECT USING ("public"."is_admin"());



CREATE POLICY "admin read incident_appeals" ON "public"."incident_appeals" FOR SELECT USING ("public"."is_admin"());



CREATE POLICY "admin read incident_report_reviews" ON "public"."incident_report_reviews" FOR SELECT USING (("public"."is_admin"() AND (("reviewer_id" = ( SELECT "auth"."uid"() AS "uid")) OR "public"."has_reviewed_incident_report"("report_id") OR "public"."is_involved_in_incident_report"("report_id") OR (EXISTS ( SELECT 1
   FROM "public"."incident_reports" "r"
  WHERE (("r"."id" = "incident_report_reviews"."report_id") AND ("r"."reviews_closed_at" IS NOT NULL)))))));



CREATE POLICY "admin read manual_result_imports" ON "public"."manual_result_imports" FOR SELECT USING ("public"."is_admin"());



CREATE POLICY "admin read page_views" ON "public"."page_views" FOR SELECT USING (( SELECT "public"."is_admin"() AS "is_admin"));



CREATE POLICY "admin read race_interviews" ON "public"."race_interviews" FOR SELECT USING ("public"."is_admin"());



CREATE POLICY "admin read signup_requests" ON "public"."signup_requests" FOR SELECT USING ("public"."is_admin"());



CREATE POLICY "admin update car_logos" ON "public"."car_logos" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update champion_photos" ON "public"."champion_photos" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update circuit_layouts" ON "public"."circuit_layouts" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update circuits" ON "public"."circuits" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update curated_race_results" ON "public"."curated_race_results" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update curated_rounds" ON "public"."curated_rounds" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update driver_season_car_numbers" ON "public"."driver_season_car_numbers" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update driver_season_classes" ON "public"."driver_season_classes" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update drivers" ON "public"."drivers" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update events" ON "public"."events" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update hall_of_fame_photos" ON "public"."hall_of_fame_photos" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update incident_appeals" ON "public"."incident_appeals" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update incident_reports" ON "public"."incident_reports" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update layout_corners" ON "public"."layout_corners" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update layout_incident_pins" ON "public"."layout_incident_pins" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update manual_result_imports" ON "public"."manual_result_imports" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update media_graphics" ON "public"."media_graphics" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update media_meetups" ON "public"."media_meetups" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update media_videos" ON "public"."media_videos" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update news" ON "public"."news_posts" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update news_tags" ON "public"."news_tags" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update organization_team_seasons" ON "public"."organization_team_seasons" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update organizations" ON "public"."organizations" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update page_banners" ON "public"."page_banners" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update penalties" ON "public"."penalties" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update penalty_offenses" ON "public"."penalty_offenses" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update practice results" ON "public"."curated_practice_results" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update qualifying" ON "public"."curated_qualifying" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update race_links" ON "public"."race_links" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update race_scores" ON "public"."race_scores" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update round_incident_status" ON "public"."round_incident_status" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update round_overrides" ON "public"."round_overrides" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update round_penalties" ON "public"."round_penalties" FOR UPDATE USING (( SELECT "public"."is_admin"() AS "is_admin")) WITH CHECK (( SELECT "public"."is_admin"() AS "is_admin"));



CREATE POLICY "admin update rulesets" ON "public"."scoring_rulesets" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update seasons" ON "public"."seasons" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update site_settings" ON "public"."site_settings" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update team_season_logos" ON "public"."team_season_logos" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update teams" ON "public"."teams" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin update track_guides" ON "public"."track_guides" FOR UPDATE USING ("public"."is_admin"());



CREATE POLICY "admin write car_logos" ON "public"."car_logos" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write champion_photos" ON "public"."champion_photos" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write circuit_layouts" ON "public"."circuit_layouts" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write circuits" ON "public"."circuits" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write curated_race_results" ON "public"."curated_race_results" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write curated_rounds" ON "public"."curated_rounds" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write driver_season_car_numbers" ON "public"."driver_season_car_numbers" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write driver_season_classes" ON "public"."driver_season_classes" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write drivers" ON "public"."drivers" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write events" ON "public"."events" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write hall_of_fame_photos" ON "public"."hall_of_fame_photos" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write manual_awards" ON "public"."manual_awards" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write manual_result_imports" ON "public"."manual_result_imports" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write media_graphics" ON "public"."media_graphics" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write media_meetup_drivers" ON "public"."media_meetup_drivers" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write media_meetups" ON "public"."media_meetups" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write media_videos" ON "public"."media_videos" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write news" ON "public"."news_posts" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write news_post_drivers" ON "public"."news_post_drivers" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write news_post_tags" ON "public"."news_post_tags" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write news_tags" ON "public"."news_tags" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write organization_team_seasons" ON "public"."organization_team_seasons" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write organizations" ON "public"."organizations" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write page_banners" ON "public"."page_banners" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write penalties" ON "public"."penalties" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write penalty_involved_drivers" ON "public"."penalty_involved_drivers" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write penalty_offense_links" ON "public"."penalty_offense_links" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write penalty_offenses" ON "public"."penalty_offenses" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write race_links" ON "public"."race_links" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write race_scores" ON "public"."race_scores" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write round_overrides" ON "public"."round_overrides" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write site_settings" ON "public"."site_settings" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write team_rosters" ON "public"."team_rosters" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write team_season_logos" ON "public"."team_season_logos" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write teams" ON "public"."teams" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin write track_guides" ON "public"."track_guides" FOR INSERT WITH CHECK ("public"."is_admin"());



CREATE POLICY "author or admin delete kudos" ON "public"."kudos" FOR DELETE USING (("public"."is_admin"() OR ("author_id" = ( SELECT "auth"."uid"() AS "uid"))));



ALTER TABLE "public"."car_logos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."champion_photos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."circuit_layouts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."circuits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."curated_practice_results" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."curated_qualifying" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."curated_race_results" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."curated_rounds" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."driver_classes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."driver_season_car_numbers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."driver_season_classes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."driver_statuses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."drivers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."hall_of_fame_photos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."incident_appeals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."incident_report_drivers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."incident_report_review_drivers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."incident_report_reviews" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."incident_reports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "insert activity_log" ON "public"."activity_log" FOR INSERT WITH CHECK (("public"."is_admin"() OR (( SELECT "auth"."uid"() AS "uid") = "actor_id")));



ALTER TABLE "public"."kudos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."kudos_drivers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."layout_corners" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."layout_incident_pins" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."manual_awards" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."manual_result_imports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."media_graphics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."media_meetup_drivers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."media_meetups" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."media_videos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."news_post_drivers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."news_post_tags" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."news_posts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."news_tags" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organization_team_seasons" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."page_banners" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."page_views" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."penalties" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."penalty_involved_drivers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."penalty_offense_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."penalty_offenses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "posted or admin read penalties" ON "public"."penalties" FOR SELECT USING ((( SELECT "public"."is_admin"() AS "is_admin") OR (EXISTS ( SELECT 1
   FROM "public"."round_incident_status" "s"
  WHERE (("s"."subsession_id" = "penalties"."subsession_id") AND "s"."posted")))));



CREATE POLICY "posted or admin read penalty_involved_drivers" ON "public"."penalty_involved_drivers" FOR SELECT USING ((( SELECT "public"."is_admin"() AS "is_admin") OR (EXISTS ( SELECT 1
   FROM ("public"."penalties" "p"
     JOIN "public"."round_incident_status" "s" ON (("s"."subsession_id" = "p"."subsession_id")))
  WHERE (("p"."id" = "penalty_involved_drivers"."penalty_id") AND "s"."posted")))));



CREATE POLICY "posted or admin read penalty_offense_links" ON "public"."penalty_offense_links" FOR SELECT USING ((( SELECT "public"."is_admin"() AS "is_admin") OR (EXISTS ( SELECT 1
   FROM ("public"."penalties" "p"
     JOIN "public"."round_incident_status" "s" ON (("s"."subsession_id" = "p"."subsession_id")))
  WHERE (("p"."id" = "penalty_offense_links"."penalty_id") AND "s"."posted")))));



CREATE POLICY "posted or admin read race_scores" ON "public"."race_scores" FOR SELECT USING ((( SELECT "public"."is_admin"() AS "is_admin") OR (EXISTS ( SELECT 1
   FROM "public"."round_incident_status" "s"
  WHERE (("s"."subsession_id" = "race_scores"."subsession_id") AND "s"."posted")))));



CREATE POLICY "posted or admin read round_penalties" ON "public"."round_penalties" FOR SELECT USING ((( SELECT "public"."is_admin"() AS "is_admin") OR (EXISTS ( SELECT 1
   FROM "public"."round_incident_status" "s"
  WHERE (("s"."subsession_id" = "round_penalties"."subsession_id") AND "s"."posted")))));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "public read" ON "public"."car_logos" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."champion_photos" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."circuit_layouts" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."circuits" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."curated_practice_results" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."curated_qualifying" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."curated_race_results" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."curated_rounds" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."driver_classes" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."driver_season_car_numbers" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."driver_season_classes" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."driver_statuses" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."drivers" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."events" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."hall_of_fame_photos" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."manual_awards" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."media_graphics" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."media_meetup_drivers" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."media_meetups" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."media_videos" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."news_post_drivers" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."news_post_tags" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."news_tags" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."organization_team_seasons" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."organizations" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."penalty_offenses" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."race_links" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."round_overrides" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."seasons" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."team_rosters" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."team_season_logos" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."teams" FOR SELECT USING (true);



CREATE POLICY "public read" ON "public"."track_guides" FOR SELECT USING (true);



CREATE POLICY "public read kudos" ON "public"."kudos" FOR SELECT USING (true);



CREATE POLICY "public read kudos_drivers" ON "public"."kudos_drivers" FOR SELECT USING (true);



CREATE POLICY "public read layout_corners" ON "public"."layout_corners" FOR SELECT USING (true);



CREATE POLICY "public read layout_incident_pins" ON "public"."layout_incident_pins" FOR SELECT USING (true);



CREATE POLICY "public read page_banners" ON "public"."page_banners" FOR SELECT USING (true);



CREATE POLICY "public read round_incident_status" ON "public"."round_incident_status" FOR SELECT USING (true);



CREATE POLICY "public read rulesets" ON "public"."scoring_rulesets" FOR SELECT USING (true);



CREATE POLICY "public read site_settings" ON "public"."site_settings" FOR SELECT USING (true);



ALTER TABLE "public"."race_interviews" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."race_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."race_scores" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "read news" ON "public"."news_posts" FOR SELECT USING (("public"."is_admin"() OR ("status" = 'published'::"text")));



CREATE POLICY "read profile" ON "public"."profiles" FOR SELECT USING (("public"."is_admin"() OR (( SELECT "auth"."uid"() AS "uid") = "id")));



CREATE POLICY "read with review incident_report_review_drivers" ON "public"."incident_report_review_drivers" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."incident_report_reviews" "v"
  WHERE ("v"."id" = "incident_report_review_drivers"."review_id"))));



CREATE POLICY "reporter or admin read incident_report_drivers" ON "public"."incident_report_drivers" FOR SELECT USING (("public"."is_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."incident_reports" "r"
  WHERE (("r"."id" = "incident_report_drivers"."report_id") AND ("r"."reporter_id" = ( SELECT "auth"."uid"() AS "uid")))))));



CREATE POLICY "reporter or admin read incident_reports" ON "public"."incident_reports" FOR SELECT USING (("public"."is_admin"() OR ("reporter_id" = ( SELECT "auth"."uid"() AS "uid"))));



ALTER TABLE "public"."round_incident_status" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."round_overrides" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."round_penalties" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."scoring_rulesets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."seasons" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."signup_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."site_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."team_rosters" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."team_season_logos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."teams" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."track_guides" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "update profile" ON "public"."profiles" FOR UPDATE USING (("public"."is_admin"() OR (( SELECT "auth"."uid"() AS "uid") = "id")));



GRANT USAGE ON SCHEMA "private" TO "anon";
GRANT USAGE ON SCHEMA "private" TO "authenticated";
GRANT USAGE ON SCHEMA "private" TO "service_role";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "private"."has_reviewed_incident_report"("p_report_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."has_reviewed_incident_report"("p_report_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "private"."has_reviewed_incident_report"("p_report_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "private"."has_reviewed_incident_report"("p_report_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "private"."is_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "private"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "private"."is_admin"() TO "service_role";



REVOKE ALL ON FUNCTION "private"."is_involved_in_incident_report"("p_report_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."is_involved_in_incident_report"("p_report_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "private"."is_involved_in_incident_report"("p_report_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "private"."is_involved_in_incident_report"("p_report_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."ack_signup_rejections"("p_request_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ack_signup_rejections"("p_request_ids" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_delete_user"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_delete_user"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_delete_user"("p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_list_user_emails"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_list_user_emails"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_list_user_emails"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."approve_signup_request"("p_request_id" "uuid", "p_name" "text", "p_iracing_cust_id" bigint, "p_class_id" integer, "p_driver_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."approve_signup_request"("p_request_id" "uuid", "p_name" "text", "p_iracing_cust_id" bigint, "p_class_id" integer, "p_driver_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."approve_signup_request"("p_request_id" "uuid", "p_name" "text", "p_iracing_cust_id" bigint, "p_class_id" integer, "p_driver_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."can_upload_incident_appeal_file"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."can_upload_incident_appeal_file"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_upload_incident_appeal_file"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."car_number_holder"("p_number" integer, "p_exclude_driver_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."car_number_holder"("p_number" integer, "p_exclude_driver_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."clear_incident_report_dismissal_reason"() TO "anon";
GRANT ALL ON FUNCTION "public"."clear_incident_report_dismissal_reason"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."clear_incident_report_dismissal_reason"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enforce_team_roster_limits"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enforce_team_roster_limits"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_missing_race_results_count"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_missing_race_results_count"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_missing_race_results_count"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_news_post_view_counts"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_news_post_view_counts"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_news_post_view_counts"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_page_view_stats"("p_days" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_page_view_stats"("p_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_page_view_stats"("p_days" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."handle_new_user"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."has_reviewed_incident_report"("p_report_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."has_reviewed_incident_report"("p_report_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."has_reviewed_incident_report"("p_report_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_reviewed_incident_report"("p_report_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."has_submitted_race_interview"("p_subsession_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."has_submitted_race_interview"("p_subsession_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_submitted_race_interview"("p_subsession_id" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."incident_report_review_counts"("p_subsession_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."incident_report_review_counts"("p_subsession_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."incident_report_review_counts"("p_subsession_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_involved_in_incident_report"("p_report_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_involved_in_incident_report"("p_report_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_involved_in_incident_report"("p_report_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_involved_in_incident_report"("p_report_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_race_interview_path_submitted"("p_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_race_interview_path_submitted"("p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_race_interview_path_submitted"("p_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."pending_signup_rejections"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pending_signup_rejections"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."prevent_role_self_escalation"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."prevent_role_self_escalation"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."recalculate_race_scores"("p_subsession_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."recalculate_race_scores"("p_subsession_id" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."recalculate_season_scores"("p_season_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."recalculate_season_scores"("p_season_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."recalculate_season_scores"("p_season_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_page_view"("p_path" "text", "p_visitor_hash" "text", "p_country" "text", "p_status" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_page_view"("p_path" "text", "p_visitor_hash" "text", "p_country" "text", "p_status" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."record_page_view"("p_path" "text", "p_visitor_hash" "text", "p_country" "text", "p_status" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_page_view"("p_path" "text", "p_visitor_hash" "text", "p_country" "text", "p_status" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reject_signup_request"("p_request_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reject_signup_request"("p_request_id" "uuid", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reject_signup_request"("p_request_id" "uuid", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."relink_drivers_from_results"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."relink_drivers_from_results"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."relink_rounds_to_seasons"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."relink_rounds_to_seasons"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."renumber_season_rounds"("p_season_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."renumber_season_rounds"("p_season_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."save_incident_report_review"("p_report_id" "uuid", "p_faults" "jsonb", "p_explanation" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."save_incident_report_review"("p_report_id" "uuid", "p_faults" "jsonb", "p_explanation" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."save_incident_report_review"("p_report_id" "uuid", "p_faults" "jsonb", "p_explanation" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_driver_audit_fields"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_driver_audit_fields"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_driver_audit_fields"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_driver_car_number"("p_driver_id" "uuid", "p_car_number" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_driver_car_number"("p_driver_id" "uuid", "p_car_number" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_driver_car_number"("p_driver_id" "uuid", "p_car_number" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."stamp_incident_report_reviews_closed"() TO "anon";
GRANT ALL ON FUNCTION "public"."stamp_incident_report_reviews_closed"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."stamp_incident_report_reviews_closed"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."submit_incident_appeal"("p_id" "uuid", "p_penalty_id" "uuid", "p_message" "text", "p_files" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_incident_appeal"("p_id" "uuid", "p_penalty_id" "uuid", "p_message" "text", "p_files" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."submit_incident_appeal"("p_id" "uuid", "p_penalty_id" "uuid", "p_message" "text", "p_files" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."submit_incident_report"("p_subsession_id" bigint, "p_session" "text", "p_lap" integer, "p_turn" "text", "p_description" "text", "p_driver_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_incident_report"("p_subsession_id" bigint, "p_session" "text", "p_lap" integer, "p_turn" "text", "p_description" "text", "p_driver_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."submit_incident_report"("p_subsession_id" bigint, "p_session" "text", "p_lap" integer, "p_turn" "text", "p_description" "text", "p_driver_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."submit_incident_report"("p_subsession_id" bigint, "p_session" "text", "p_lap" integer, "p_turn" "text", "p_description" "text", "p_driver_ids" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."submit_kudos"("p_subsession_id" bigint, "p_session" "text", "p_lap" integer, "p_turn" "text", "p_description" "text", "p_clip_url" "text", "p_driver_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_kudos"("p_subsession_id" bigint, "p_session" "text", "p_lap" integer, "p_turn" "text", "p_description" "text", "p_clip_url" "text", "p_driver_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."submit_kudos"("p_subsession_id" bigint, "p_session" "text", "p_lap" integer, "p_turn" "text", "p_description" "text", "p_clip_url" "text", "p_driver_ids" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."submit_race_interview"("p_id" "uuid", "p_subsession_id" bigint, "p_audio_path" "text", "p_audio_type" "text", "p_duration_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_race_interview"("p_id" "uuid", "p_subsession_id" bigint, "p_audio_path" "text", "p_audio_type" "text", "p_duration_seconds" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."submit_race_interview"("p_id" "uuid", "p_subsession_id" bigint, "p_audio_path" "text", "p_audio_type" "text", "p_duration_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."submit_signup_request"("p_discord_user_id" "text", "p_discord_username" "text", "p_name" "text", "p_numbers" integer[], "p_iracing_cust_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_signup_request"("p_discord_user_id" "text", "p_discord_username" "text", "p_name" "text", "p_numbers" integer[], "p_iracing_cust_id" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_driver_statuses"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_driver_statuses"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_driver_statuses"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_results_with_roster"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_results_with_roster"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_results_with_roster"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_rookie_status"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_rookie_status"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_rookie_status"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."update_my_driver_profile"("p_bio" "text", "p_photo_url" "text", "p_set_photo" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_my_driver_profile"("p_bio" "text", "p_photo_url" "text", "p_set_photo" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_my_driver_profile"("p_bio" "text", "p_photo_url" "text", "p_set_photo" boolean) TO "service_role";



GRANT ALL ON TABLE "public"."activity_log" TO "anon";
GRANT ALL ON TABLE "public"."activity_log" TO "authenticated";
GRANT ALL ON TABLE "public"."activity_log" TO "service_role";



GRANT ALL ON TABLE "public"."car_logos" TO "anon";
GRANT ALL ON TABLE "public"."car_logos" TO "authenticated";
GRANT ALL ON TABLE "public"."car_logos" TO "service_role";



GRANT ALL ON TABLE "public"."champion_photos" TO "anon";
GRANT ALL ON TABLE "public"."champion_photos" TO "authenticated";
GRANT ALL ON TABLE "public"."champion_photos" TO "service_role";



GRANT ALL ON TABLE "public"."circuit_layouts" TO "anon";
GRANT ALL ON TABLE "public"."circuit_layouts" TO "authenticated";
GRANT ALL ON TABLE "public"."circuit_layouts" TO "service_role";



GRANT ALL ON TABLE "public"."circuits" TO "anon";
GRANT ALL ON TABLE "public"."circuits" TO "authenticated";
GRANT ALL ON TABLE "public"."circuits" TO "service_role";



GRANT ALL ON TABLE "public"."curated_practice_results" TO "anon";
GRANT ALL ON TABLE "public"."curated_practice_results" TO "authenticated";
GRANT ALL ON TABLE "public"."curated_practice_results" TO "service_role";



GRANT ALL ON TABLE "public"."curated_qualifying" TO "anon";
GRANT ALL ON TABLE "public"."curated_qualifying" TO "authenticated";
GRANT ALL ON TABLE "public"."curated_qualifying" TO "service_role";



GRANT ALL ON TABLE "public"."curated_race_results" TO "anon";
GRANT ALL ON TABLE "public"."curated_race_results" TO "authenticated";
GRANT ALL ON TABLE "public"."curated_race_results" TO "service_role";



GRANT ALL ON TABLE "public"."curated_rounds" TO "anon";
GRANT ALL ON TABLE "public"."curated_rounds" TO "authenticated";
GRANT ALL ON TABLE "public"."curated_rounds" TO "service_role";



GRANT ALL ON TABLE "public"."driver_classes" TO "anon";
GRANT ALL ON TABLE "public"."driver_classes" TO "authenticated";
GRANT ALL ON TABLE "public"."driver_classes" TO "service_role";



GRANT ALL ON SEQUENCE "public"."driver_classes_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."driver_classes_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."driver_classes_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."drivers" TO "anon";
GRANT ALL ON TABLE "public"."drivers" TO "authenticated";
GRANT ALL ON TABLE "public"."drivers" TO "service_role";



GRANT SELECT("id") ON TABLE "public"."drivers" TO "anon";



GRANT SELECT("car_number") ON TABLE "public"."drivers" TO "anon";



GRANT SELECT("name") ON TABLE "public"."drivers" TO "anon";



GRANT SELECT("status_id") ON TABLE "public"."drivers" TO "anon";



GRANT SELECT("class_id") ON TABLE "public"."drivers" TO "anon";



GRANT SELECT("team_id") ON TABLE "public"."drivers" TO "anon";



GRANT SELECT("is_rookie") ON TABLE "public"."drivers" TO "anon";



GRANT SELECT("car") ON TABLE "public"."drivers" TO "anon";



GRANT SELECT("appearances") ON TABLE "public"."drivers" TO "anon";



GRANT SELECT("starts") ON TABLE "public"."drivers" TO "anon";



GRANT SELECT("seasons_count") ON TABLE "public"."drivers" TO "anon";



GRANT SELECT("penalty_points") ON TABLE "public"."drivers" TO "anon";



GRANT SELECT("penalty_points_max") ON TABLE "public"."drivers" TO "anon";



GRANT SELECT("photo_url") ON TABLE "public"."drivers" TO "anon";



GRANT SELECT("bio") ON TABLE "public"."drivers" TO "anon";



GRANT SELECT("created_at") ON TABLE "public"."drivers" TO "anon";



GRANT SELECT("updated_at") ON TABLE "public"."drivers" TO "anon";



GRANT ALL ON TABLE "public"."driver_last_race" TO "anon";
GRANT ALL ON TABLE "public"."driver_last_race" TO "authenticated";
GRANT ALL ON TABLE "public"."driver_last_race" TO "service_role";



GRANT ALL ON TABLE "public"."driver_season_car_numbers" TO "anon";
GRANT ALL ON TABLE "public"."driver_season_car_numbers" TO "authenticated";
GRANT ALL ON TABLE "public"."driver_season_car_numbers" TO "service_role";



GRANT ALL ON TABLE "public"."driver_season_classes" TO "anon";
GRANT ALL ON TABLE "public"."driver_season_classes" TO "authenticated";
GRANT ALL ON TABLE "public"."driver_season_classes" TO "service_role";



GRANT ALL ON TABLE "public"."driver_statuses" TO "anon";
GRANT ALL ON TABLE "public"."driver_statuses" TO "authenticated";
GRANT ALL ON TABLE "public"."driver_statuses" TO "service_role";



GRANT ALL ON SEQUENCE "public"."driver_statuses_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."driver_statuses_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."driver_statuses_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."events" TO "anon";
GRANT ALL ON TABLE "public"."events" TO "authenticated";
GRANT ALL ON TABLE "public"."events" TO "service_role";



GRANT ALL ON TABLE "public"."hall_of_fame_photos" TO "anon";
GRANT ALL ON TABLE "public"."hall_of_fame_photos" TO "authenticated";
GRANT ALL ON TABLE "public"."hall_of_fame_photos" TO "service_role";



GRANT ALL ON TABLE "public"."incident_appeals" TO "anon";
GRANT ALL ON TABLE "public"."incident_appeals" TO "authenticated";
GRANT ALL ON TABLE "public"."incident_appeals" TO "service_role";



GRANT ALL ON TABLE "public"."incident_report_drivers" TO "anon";
GRANT ALL ON TABLE "public"."incident_report_drivers" TO "authenticated";
GRANT ALL ON TABLE "public"."incident_report_drivers" TO "service_role";



GRANT ALL ON TABLE "public"."incident_report_review_drivers" TO "anon";
GRANT ALL ON TABLE "public"."incident_report_review_drivers" TO "authenticated";
GRANT ALL ON TABLE "public"."incident_report_review_drivers" TO "service_role";



GRANT ALL ON TABLE "public"."incident_report_reviews" TO "anon";
GRANT ALL ON TABLE "public"."incident_report_reviews" TO "authenticated";
GRANT ALL ON TABLE "public"."incident_report_reviews" TO "service_role";



GRANT ALL ON TABLE "public"."incident_reports" TO "anon";
GRANT ALL ON TABLE "public"."incident_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."incident_reports" TO "service_role";



GRANT ALL ON TABLE "public"."kudos" TO "anon";
GRANT ALL ON TABLE "public"."kudos" TO "authenticated";
GRANT ALL ON TABLE "public"."kudos" TO "service_role";



GRANT ALL ON TABLE "public"."kudos_drivers" TO "anon";
GRANT ALL ON TABLE "public"."kudos_drivers" TO "authenticated";
GRANT ALL ON TABLE "public"."kudos_drivers" TO "service_role";



GRANT ALL ON TABLE "public"."layout_corners" TO "anon";
GRANT ALL ON TABLE "public"."layout_corners" TO "authenticated";
GRANT ALL ON TABLE "public"."layout_corners" TO "service_role";



GRANT ALL ON TABLE "public"."layout_incident_pins" TO "anon";
GRANT ALL ON TABLE "public"."layout_incident_pins" TO "authenticated";
GRANT ALL ON TABLE "public"."layout_incident_pins" TO "service_role";



GRANT ALL ON TABLE "public"."manual_awards" TO "anon";
GRANT ALL ON TABLE "public"."manual_awards" TO "authenticated";
GRANT ALL ON TABLE "public"."manual_awards" TO "service_role";



GRANT ALL ON TABLE "public"."manual_result_imports" TO "anon";
GRANT ALL ON TABLE "public"."manual_result_imports" TO "authenticated";
GRANT ALL ON TABLE "public"."manual_result_imports" TO "service_role";



GRANT ALL ON TABLE "public"."media_graphics" TO "anon";
GRANT ALL ON TABLE "public"."media_graphics" TO "authenticated";
GRANT ALL ON TABLE "public"."media_graphics" TO "service_role";



GRANT ALL ON TABLE "public"."media_meetup_drivers" TO "anon";
GRANT ALL ON TABLE "public"."media_meetup_drivers" TO "authenticated";
GRANT ALL ON TABLE "public"."media_meetup_drivers" TO "service_role";



GRANT ALL ON TABLE "public"."media_meetups" TO "anon";
GRANT ALL ON TABLE "public"."media_meetups" TO "authenticated";
GRANT ALL ON TABLE "public"."media_meetups" TO "service_role";



GRANT ALL ON TABLE "public"."media_videos" TO "anon";
GRANT ALL ON TABLE "public"."media_videos" TO "authenticated";
GRANT ALL ON TABLE "public"."media_videos" TO "service_role";



GRANT ALL ON TABLE "public"."news_post_drivers" TO "anon";
GRANT ALL ON TABLE "public"."news_post_drivers" TO "authenticated";
GRANT ALL ON TABLE "public"."news_post_drivers" TO "service_role";



GRANT ALL ON TABLE "public"."news_post_tags" TO "anon";
GRANT ALL ON TABLE "public"."news_post_tags" TO "authenticated";
GRANT ALL ON TABLE "public"."news_post_tags" TO "service_role";



GRANT ALL ON TABLE "public"."news_posts" TO "anon";
GRANT ALL ON TABLE "public"."news_posts" TO "authenticated";
GRANT ALL ON TABLE "public"."news_posts" TO "service_role";



GRANT ALL ON TABLE "public"."news_tags" TO "anon";
GRANT ALL ON TABLE "public"."news_tags" TO "authenticated";
GRANT ALL ON TABLE "public"."news_tags" TO "service_role";



GRANT ALL ON TABLE "public"."organization_team_seasons" TO "anon";
GRANT ALL ON TABLE "public"."organization_team_seasons" TO "authenticated";
GRANT ALL ON TABLE "public"."organization_team_seasons" TO "service_role";



GRANT ALL ON TABLE "public"."organizations" TO "anon";
GRANT ALL ON TABLE "public"."organizations" TO "authenticated";
GRANT ALL ON TABLE "public"."organizations" TO "service_role";



GRANT ALL ON TABLE "public"."page_banners" TO "anon";
GRANT ALL ON TABLE "public"."page_banners" TO "authenticated";
GRANT ALL ON TABLE "public"."page_banners" TO "service_role";



GRANT ALL ON TABLE "public"."page_views" TO "anon";
GRANT ALL ON TABLE "public"."page_views" TO "authenticated";
GRANT ALL ON TABLE "public"."page_views" TO "service_role";



GRANT ALL ON SEQUENCE "public"."page_views_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."page_views_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."page_views_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."penalties" TO "anon";
GRANT ALL ON TABLE "public"."penalties" TO "authenticated";
GRANT ALL ON TABLE "public"."penalties" TO "service_role";



GRANT ALL ON TABLE "public"."penalty_involved_drivers" TO "anon";
GRANT ALL ON TABLE "public"."penalty_involved_drivers" TO "authenticated";
GRANT ALL ON TABLE "public"."penalty_involved_drivers" TO "service_role";



GRANT ALL ON TABLE "public"."penalty_offense_links" TO "anon";
GRANT ALL ON TABLE "public"."penalty_offense_links" TO "authenticated";
GRANT ALL ON TABLE "public"."penalty_offense_links" TO "service_role";



GRANT ALL ON TABLE "public"."penalty_offenses" TO "anon";
GRANT ALL ON TABLE "public"."penalty_offenses" TO "authenticated";
GRANT ALL ON TABLE "public"."penalty_offenses" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."race_interviews" TO "anon";
GRANT ALL ON TABLE "public"."race_interviews" TO "authenticated";
GRANT ALL ON TABLE "public"."race_interviews" TO "service_role";



GRANT ALL ON TABLE "public"."race_links" TO "anon";
GRANT ALL ON TABLE "public"."race_links" TO "authenticated";
GRANT ALL ON TABLE "public"."race_links" TO "service_role";



GRANT ALL ON TABLE "public"."race_scores" TO "anon";
GRANT ALL ON TABLE "public"."race_scores" TO "authenticated";
GRANT ALL ON TABLE "public"."race_scores" TO "service_role";



GRANT ALL ON TABLE "public"."round_incident_status" TO "anon";
GRANT ALL ON TABLE "public"."round_incident_status" TO "authenticated";
GRANT ALL ON TABLE "public"."round_incident_status" TO "service_role";



GRANT ALL ON TABLE "public"."race_scores_public" TO "service_role";
GRANT SELECT ON TABLE "public"."race_scores_public" TO "anon";
GRANT SELECT ON TABLE "public"."race_scores_public" TO "authenticated";



GRANT ALL ON TABLE "public"."round_overrides" TO "anon";
GRANT ALL ON TABLE "public"."round_overrides" TO "authenticated";
GRANT ALL ON TABLE "public"."round_overrides" TO "service_role";



GRANT ALL ON TABLE "public"."round_penalties" TO "anon";
GRANT ALL ON TABLE "public"."round_penalties" TO "authenticated";
GRANT ALL ON TABLE "public"."round_penalties" TO "service_role";



GRANT ALL ON TABLE "public"."scoring_rulesets" TO "anon";
GRANT ALL ON TABLE "public"."scoring_rulesets" TO "authenticated";
GRANT ALL ON TABLE "public"."scoring_rulesets" TO "service_role";



GRANT ALL ON TABLE "public"."seasons" TO "anon";
GRANT ALL ON TABLE "public"."seasons" TO "authenticated";
GRANT ALL ON TABLE "public"."seasons" TO "service_role";



GRANT ALL ON TABLE "public"."signup_requests" TO "anon";
GRANT ALL ON TABLE "public"."signup_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."signup_requests" TO "service_role";



GRANT ALL ON TABLE "public"."site_settings" TO "anon";
GRANT ALL ON TABLE "public"."site_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."site_settings" TO "service_role";



GRANT ALL ON TABLE "public"."team_rosters" TO "anon";
GRANT ALL ON TABLE "public"."team_rosters" TO "authenticated";
GRANT ALL ON TABLE "public"."team_rosters" TO "service_role";



GRANT ALL ON TABLE "public"."team_season_logos" TO "anon";
GRANT ALL ON TABLE "public"."team_season_logos" TO "authenticated";
GRANT ALL ON TABLE "public"."team_season_logos" TO "service_role";



GRANT ALL ON TABLE "public"."teams" TO "anon";
GRANT ALL ON TABLE "public"."teams" TO "authenticated";
GRANT ALL ON TABLE "public"."teams" TO "service_role";



GRANT ALL ON TABLE "public"."track_guides" TO "anon";
GRANT ALL ON TABLE "public"."track_guides" TO "authenticated";
GRANT ALL ON TABLE "public"."track_guides" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







