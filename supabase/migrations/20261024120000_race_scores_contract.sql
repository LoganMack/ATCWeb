-- Retire the legacy race scores (unit scoring-ownership, contract step: BR6.4, BR3.4).
--
-- What:
--   1. A catalog check: stops the migration when any function, other than the ones this file
--      rewrites or drops, still names race_scores, race_scores_public or recalculate_race_scores.
--   2. Rewrites the functions that used the legacy objects. plpgsql has no dependency tracking, so
--      without this the drop would succeed and these would fail at run time:
--        * recalculate_season_scores(uuid) becomes a wrapper for rescore_season(uuid), with the
--          same signature, result columns and admin check;
--        * sync_results_with_roster() keeps its result shape but no longer rescores rounds itself:
--          linking or creating a driver fires the drivers scoring triggers, which rescore every
--          round of that cust_id (BR3.1). It reports those rounds, and any round left with a
--          scoring issue from this run. An entrant whose link would change a locked season is
--          skipped and reported, instead of failing the whole sync (BR3.3);
--        * submit_kudos(...) checks race sessions and cars against race_score_results;
--        * score_round(bigint) only loses a code comment that named recalculate_race_scores().
--   3. Copies race_scores into race_scores_archive (service_role read only), then drops
--      race_scores_public, recalculate_race_scores(bigint) and race_scores.
--   4. The same catalog check again, with no exceptions, after the drop.
--
-- Why: since the switch (PR #109) every page reads race_score_results_public, and the external
-- pipeline no longer writes race_scores (Step 15). Keeping a second, stale copy of every score
-- invites a reader to use the wrong one. The archive keeps the last legacy scores for reference
-- and for the down script.
--
-- Production: run only after the pipeline has stopped writing race_scores. If it still writes,
-- its inserts fail once this is applied. Nothing in this repository writes race_scores.
--
-- Undo: supabase/down/20261024120000_race_scores_contract.down.sql recreates race_scores (filled
-- from the archive), recalculate_race_scores and race_scores_public as the baseline defines them,
-- restores the old function bodies, and drops the archive.

do $$
declare
  v_names text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
  into v_names
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not in ('pg_catalog', 'information_schema')
    and p.prosrc ~ '\m(race_scores|race_scores_public|recalculate_race_scores)\M'
    and p.oid not in (
      'public.recalculate_race_scores(bigint)'::regprocedure,
      'public.recalculate_season_scores(uuid)'::regprocedure,
      'public.sync_results_with_roster()'::regprocedure,
      'public.submit_kudos(bigint, text, integer, text, text, text, uuid[])'::regprocedure,
      'public.score_round(bigint)'::regprocedure
    );
  if v_names is not null then
    raise exception 'Contract stopped: these functions still use the legacy race scores: %', v_names;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Functions that used the legacy objects
-- ---------------------------------------------------------------------------------------------

-- score_round: only the comment on its advisory lock changes; the body is otherwise the one
-- 20261021120000 created.
create or replace function public.score_round(p_subsession_id bigint) returns integer
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_season_id uuid;
  v_locked_name text;
  v_reason text;
  v_rows public.race_score_results[];
  v_has_rows boolean;
  v_written integer;
begin
  select cr.season_id into v_season_id from public.curated_rounds cr where cr.subsession_id = p_subsession_id;
  if not found then
    return 0; -- deleted in the same statement; the cascade already removed its rows
  end if;

  -- One lock per season, so concurrent rescores of the same season serialise.
  if v_season_id is not null then
    perform pg_advisory_xact_lock(hashtext(v_season_id::text));
  end if;

  -- A locked season is the round's season or, for a round just moved, the season its stored rows
  -- belong to (BR3.3).
  select s.name into v_locked_name
  from public.seasons s
  where s.standings_locked_at is not null
    and (s.id = v_season_id
         or s.id in (select r.season_id from public.race_score_results r where r.subsession_id = p_subsession_id))
  order by (s.id = v_season_id) desc
  limit 1;

  v_has_rows := exists (select 1 from public.race_score_results r where r.subsession_id = p_subsession_id);
  v_reason := private.scoring_unscorable_reason(p_subsession_id);

  if v_reason is not null then
    if v_locked_name is not null and v_has_rows then
      raise exception 'This change would alter results in %, whose standings are locked. Unlock the season first.', v_locked_name
        using errcode = 'SC001';
    end if;
    delete from public.race_score_results r where r.subsession_id = p_subsession_id;
    perform private.scoring_record_issue(p_subsession_id, v_season_id, v_reason);
    return 0;
  end if;

  v_rows := array(select c from private.scoring_compute(p_subsession_id, '{}'::jsonb) c);

  if v_locked_name is not null then
    if exists (
         select to_jsonb(x) - 'scored_at' from unnest(v_rows) x
         except
         select to_jsonb(r) - 'scored_at' from public.race_score_results r where r.subsession_id = p_subsession_id
       )
       or exists (
         select to_jsonb(r) - 'scored_at' from public.race_score_results r where r.subsession_id = p_subsession_id
         except
         select to_jsonb(x) - 'scored_at' from unnest(v_rows) x
       ) then
      raise exception 'This change would alter results in %, whose standings are locked. Unlock the season first.', v_locked_name
        using errcode = 'SC001';
    end if;
    delete from public.scoring_issues si where si.subsession_id = p_subsession_id;
    return 0; -- unchanged: nothing to write
  end if;

  perform set_config('atc.scoring_writer', 'on', true);
  delete from public.race_score_results r where r.subsession_id = p_subsession_id;
  insert into public.race_score_results select * from unnest(v_rows);
  get diagnostics v_written = row_count;
  perform set_config('atc.scoring_writer', 'off', true);

  delete from public.scoring_issues si where si.subsession_id = p_subsession_id;
  return v_written;
end;
$$;

create or replace function public.recalculate_season_scores(p_season_id uuid)
  returns table (subsession_id bigint, rows_written integer, error_message text)
  language plpgsql security definer
  set search_path = ''
  as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an admin can recalculate scores'
      using errcode = 'insufficient_privilege';
  end if;
  return query
    select r.subsession_id, r.rows_written, r.error_message
    from public.rescore_season(p_season_id) r;
end;
$$;

comment on function public.recalculate_season_scores(uuid) is
  'Kept for older callers: the same as rescore_season(uuid), one row per round of the season.';

create or replace function public.sync_results_with_roster() returns jsonb
  language plpgsql security definer
  set search_path = 'public'
  as $$
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
  v_custs              bigint[] := '{}';
  v_rounds_recalculated integer := 0;
  v_recalc_failed       text[] := '{}';
  v_round_failed        text[];
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

    v_match_name := null;
    v_created_name := null;
    -- The link or insert fires the drivers scoring triggers, which rescore every round this
    -- cust_id has results in (BR3.1). A locked season refuses a change to its results (SC001):
    -- that entrant is skipped and reported, and the others still sync.
    begin
      if v_match_count = 1 then
        select d.id, d.name into v_match_id, v_match_name
        from public.drivers d
        where d.iracing_cust_id is null
          and lower(trim(d.name)) = lower(trim(v_entrant.display_name));

        update public.drivers set iracing_cust_id = v_entrant.cust_id where id = v_match_id;
      else
        insert into public.drivers (name, iracing_cust_id, class_id, status_id, is_rookie)
        values (v_entrant.display_name, v_entrant.cust_id, v_default_class_id, v_new_status_id, true)
        returning name into v_created_name;
      end if;
    exception when sqlstate 'SC001' then
      v_recalc_failed := array_append(v_recalc_failed,
        v_entrant.display_name || ' (cust ' || v_entrant.cust_id::text || ', not synced): ' || sqlerrm);
      continue;
    end;

    if v_match_count = 1 then
      v_linked := array_append(v_linked, v_match_name);
    else
      v_created := array_append(v_created, v_created_name);
    end if;
    v_custs := array_append(v_custs, v_entrant.cust_id);
  end loop;

  -- The rounds the triggers rescored just now. A round that could not be scored has a
  -- scoring_issues row stamped with this transaction's time.
  if cardinality(v_custs) > 0 and private.scoring_triggers_enabled() then
    select
      count(*) filter (where si.subsession_id is null),
      coalesce(array_agg(t.subsession_id::text || ': ' || si.message order by t.subsession_id)
                 filter (where si.subsession_id is not null), '{}')
    into v_rounds_recalculated, v_round_failed
    from (
      select rr.subsession_id from public.curated_race_results rr where rr.cust_id = any (v_custs)
      union
      select cq.subsession_id from public.curated_qualifying cq where cq.cust_id = any (v_custs)
    ) t
    left join public.scoring_issues si on si.subsession_id = t.subsession_id and si.last_seen_at = now();
    v_recalc_failed := v_recalc_failed || v_round_failed;
  end if;

  return jsonb_build_object(
    'created', to_jsonb(v_created),
    'linked', to_jsonb(v_linked),
    'roundsRecalculated', v_rounds_recalculated,
    'recalcFailed', to_jsonb(v_recalc_failed)
  );
end;
$$;

comment on function public.sync_results_with_roster() is
  'Admin only: links or creates a driver for every unrostered cust_id in a non-exhibition round. The drivers scoring triggers rescore their rounds.';

create or replace function public.submit_kudos(p_subsession_id bigint, p_session text, p_lap integer,
  p_turn text, p_description text, p_clip_url text, p_driver_ids uuid[]) returns uuid
  language plpgsql security definer
  set search_path = 'public'
  as $_$
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
  -- A race session must be one this round actually ran (race_score_results has a row
  -- per rostered driver per race), so a direct RPC call can't file 'race:99'.
  if p_session like 'race:%' and not exists (
    select 1 from race_score_results
    where subsession_id = p_subsession_id and race_number = split_part(p_session, ':', 2)::int
  ) then
    raise exception 'invalid session';
  end if;
  if p_lap > 10000 then raise exception 'invalid lap'; end if;

  -- Linked driver's name, else display name — never the email.
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
    and exists (select 1 from race_score_results rs where rs.subsession_id = p_subsession_id and rs.driver_id = d.id);
  if not found then raise exception 'no valid cars'; end if;

  return v_id;
end;
$_$;

-- ---------------------------------------------------------------------------------------------
-- Archive, then drop the legacy objects
-- ---------------------------------------------------------------------------------------------

create table public.race_scores_archive as select * from public.race_scores;

comment on table public.race_scores_archive is
  'The legacy race_scores rows as they were when the contract migration (20261024120000) dropped the table. Reference only; nothing reads it. The down script restores race_scores from it.';

-- RLS on with no policy, and no grant to anon or authenticated: only service_role reads it.
alter table public.race_scores_archive enable row level security;
revoke all on table public.race_scores_archive from public, anon, authenticated, service_role;
grant select on table public.race_scores_archive to service_role;

drop view public.race_scores_public;
drop function public.recalculate_race_scores(bigint);
drop table public.race_scores;

do $$
declare
  v_names text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
  into v_names
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not in ('pg_catalog', 'information_schema')
    and p.prosrc ~ '\m(race_scores|race_scores_public|recalculate_race_scores)\M';
  if v_names is not null then
    raise exception 'Contract stopped: these functions still use the legacy race scores: %', v_names;
  end if;
end $$;
