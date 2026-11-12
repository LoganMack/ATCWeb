-- Seasons and results polish: practice and qualifying wet flags, the New season form's insert policy, and the
-- per-race figures behind Stats > Seasons (FR4.1, FR5, FR10.4, NFR1-NFR4; rules BR4.1, BR5.6, BR10.1, BR12.1).
--
-- What:
--   1. events.practice_wet_affected and events.qualifying_wet_affected: admin-marked after the fact, like the
--      race1-3 flags, so the round results card can say whether the session in view ran wet. Off by default.
--   2. Policy "admin insert seasons": only a full admin may insert a season (Admin > Seasons > New season).
--      Seasons had no insert policy, so no one could create one from the site.
--   3. public.season_race_summaries(p_subsession_ids) returns one row per race and scope (overall, alpha, gamma,
--      delta) of the given rounds:
--        * drivers, laps_total and incidents_total: the scope's entrants in that race and their summed laps and
--          incidents. Overall counts every result row, rostered or not; a class counts only result rows matched
--          to a score row of that class.
--        * round_drivers: the scope's different entrants across every race of the round (Grid Size).
--        * winner_driver_id: overall, the classified, non-disqualified scored driver with shown position 1; a
--          class, the one with the best shown class position (lowest driver id on an unexpected tie).
--        * race_time_ten_thousandths (overall only): the winner's laps complete times their average lap, with no
--          time penalties added, as the results page's race card shows it.
--      A scope row exists only when that scope has an entrant in the race.
--
-- Why one function: Stats > Seasons must stay within the Worker's 10 ms CPU budget and read little, so it asks
-- for ready-made per-race figures instead of every result row of every season. It refuses more than 200 rounds
-- per call; the page asks in batches.
--
-- Why security invoker: it reads only views that are already safe for anon. race_score_results_public shows the
-- raw set until a round's incident report is posted and the final set after (all of it for admins), and
-- curated_race_results_shown masks hidden drivers for this caller, so the figures follow the same rules as every
-- other results page. Broadcaster-hidden rounds are left out by the page, which never passes them.
--
-- Expand only: two columns with defaults, one policy that allows something new, and a function the code on main
-- never calls, so the code on main keeps working. Undo with
-- supabase/down/20261117120000_seasons_results_polish.down.sql.

-- 1. Wet flags ------------------------------------------------------------------------------------------------
alter table public.events
  add column practice_wet_affected boolean not null default false,
  add column qualifying_wet_affected boolean not null default false;

comment on column public.events.practice_wet_affected is
  'Admin-marked after the fact: did Practice actually run in wet conditions? Same rules as race1_wet_affected; false for HOLIDAY/IRACING and To Be Determined events.';
comment on column public.events.qualifying_wet_affected is
  'Same as practice_wet_affected, for Qualifying.';

-- 2. Season inserts ---------------------------------------------------------------------------------------------
create policy "admin insert seasons" on public.seasons for insert with check (public.is_full_admin());

-- 3. Per-race figures -------------------------------------------------------------------------------------------
create function public.season_race_summaries(p_subsession_ids bigint[])
returns table (
  subsession_id bigint,
  race_number integer,
  scope text,
  winner_driver_id uuid,
  drivers integer,
  round_drivers integer,
  laps_total bigint,
  incidents_total bigint,
  race_time_ten_thousandths bigint
)
language plpgsql stable security invoker
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_subsession_ids is null or cardinality(p_subsession_ids) = 0 then
    return;
  end if;
  if cardinality(p_subsession_ids) > 200 then
    raise exception 'TOO_MANY_ROUNDS: Ask for at most 200 rounds at a time.' using errcode = '22023';
  end if;

  return query
  with entries as (
    select
      r.subsession_id::bigint as round_id,
      r.race_number as race_no,
      r.cust_id,
      r.laps_complete,
      r.average_lap_ten_thousandths,
      r.incidents,
      s.driver_id,
      s.shown_position,
      s.shown_class_position,
      coalesce(s.classified, false) and not coalesce(s.dsq, false) as can_win,
      lower(c.name) as class_key
    from public.curated_race_results_shown r
    left join public.race_score_results_public s
      on s.subsession_id = r.subsession_id
     and s.race_number = r.race_number
     and s.driver_id = r.roster_driver_id
    left join public.driver_classes c on c.id = s.class_id
    where r.subsession_id = any (p_subsession_ids)
  ),
  scoped as (
    select e.round_id, e.race_no, 'overall'::text as scope_key, e.cust_id::text as entrant,
           e.laps_complete, e.average_lap_ten_thousandths, e.incidents,
           e.driver_id, e.shown_position as rank_position, e.can_win
    from entries e
    union all
    select e.round_id, e.race_no, e.class_key, e.driver_id::text,
           e.laps_complete, e.average_lap_ten_thousandths, e.incidents,
           e.driver_id, e.shown_class_position, e.can_win
    from entries e
    where e.driver_id is not null and e.class_key in ('alpha', 'gamma', 'delta')
  ),
  race_totals as (
    select sc.round_id, sc.race_no, sc.scope_key,
           count(distinct sc.entrant)::integer as race_drivers,
           sum(sc.laps_complete)::bigint as laps_sum,
           sum(sc.incidents)::bigint as incidents_sum
    from scoped sc
    group by sc.round_id, sc.race_no, sc.scope_key
  ),
  round_totals as (
    select sc.round_id, sc.scope_key, count(distinct sc.entrant)::integer as round_entrants
    from scoped sc
    group by sc.round_id, sc.scope_key
  ),
  winners as (
    select distinct on (sc.round_id, sc.race_no, sc.scope_key)
      sc.round_id, sc.race_no, sc.scope_key, sc.driver_id,
      sc.laps_complete, sc.average_lap_ten_thousandths
    from scoped sc
    where sc.driver_id is not null
      and sc.can_win
      and sc.rank_position is not null
      and (sc.scope_key <> 'overall' or sc.rank_position = 1)
    order by sc.round_id, sc.race_no, sc.scope_key, sc.rank_position, sc.driver_id
  )
  select
    t.round_id,
    t.race_no,
    t.scope_key,
    w.driver_id,
    t.race_drivers,
    rt.round_entrants,
    t.laps_sum,
    t.incidents_sum,
    case
      when t.scope_key = 'overall' and w.laps_complete > 0 and w.average_lap_ten_thousandths > 0
        then w.laps_complete::bigint * w.average_lap_ten_thousandths::bigint
    end
  from race_totals t
  join round_totals rt on rt.round_id = t.round_id and rt.scope_key = t.scope_key
  left join winners w on w.round_id = t.round_id and w.race_no = t.race_no and w.scope_key = t.scope_key
  order by t.round_id, t.race_no, array_position(array['overall', 'alpha', 'gamma', 'delta'], t.scope_key);
end;
$$;

comment on function public.season_race_summaries(bigint[]) is
  'Per race and scope (overall, alpha, gamma, delta) of the given rounds (at most 200): entrants, round entrants, laps, incidents, winner and the overall winner''s on-track race time, from curated_race_results_shown and race_score_results_public (Stats > Seasons).';

revoke all on function public.season_race_summaries(bigint[]) from public, anon, authenticated, service_role;
grant execute on function public.season_race_summaries(bigint[]) to anon, authenticated, service_role;
