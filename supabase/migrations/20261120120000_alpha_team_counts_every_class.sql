-- Alpha Team winner counts drivers of every class (intent 261117-results-quick-fixes; FR4.3, FR5.3, NFR4).
--
-- What: public.race_winners_for_rounds(bigint[]) now picks each race's Alpha Team winner from the rows of every
-- class (Alpha, Gamma, Delta and any other), each scored by shown_class_total - shown_class_points (points
-- without class points), top 2 rows per team. The Alpha, Gamma and Delta class winners and the Delta Team
-- winner (Delta rows by class total, seasons with delta_team_enabled only) are unchanged, as are the
-- signature, result columns, tie-breaks, comment and grants. Everything else is copied from
-- 20261113120002_race_winners_for_rounds.sql.
--
-- Why: the owner defined Alpha Team as the overall, every-class team competition ("it is essentially an overall
-- category"). That is the competition round_team_stats already stores as 'overall', and the one the Champions,
-- Standings and home pages show as Alpha Team; the Race Results list counted Alpha drivers only, so its Alpha
-- Team winner could differ from theirs. No stored stats change, so nothing is recomputed.
--
-- Expand only: same signature and slots, so the code on main keeps working with the corrected winner. Undo with
-- supabase/down/20261120120000_alpha_team_counts_every_class.down.sql, which restores the previous body.

create or replace function public.race_winners_for_rounds(p_subsession_ids bigint[])
returns table (
  subsession_id bigint,
  race_number integer,
  slot text,
  driver_id uuid,
  driver_name text,
  driver_hidden boolean,
  team_id uuid,
  team_name text,
  team_logo_url text
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
    -- Every class: the Alpha Team slot counts them all.
    select
      r.subsession_id,
      r.race_number,
      r.driver_id,
      r.team_id,
      r.dsq,
      r.classified,
      r.shown_class_position,
      r.shown_class_total,
      r.shown_class_points,
      lower(c.name) as class_key,
      coalesce(s.delta_team_enabled, false) as delta_team_enabled
    from public.race_score_results_public r
    join public.driver_classes c on c.id = r.class_id
    left join public.seasons s on s.id = r.season_id
    where r.subsession_id = any (p_subsession_ids)
  ),
  class_winners as (
    select distinct on (e.subsession_id, e.race_number, e.class_key)
      e.subsession_id, e.race_number, e.class_key as slot, e.driver_id
    from entries e
    where e.class_key in ('alpha', 'gamma', 'delta')
      and not e.dsq and e.classified and e.shown_class_position is not null
    order by e.subsession_id, e.race_number, e.class_key, e.shown_class_position, e.driver_id
  ),
  slot_entries as (
    -- Alpha Team: every class's rows without class points.
    select e.subsession_id, e.race_number, 'alpha_team' as slot, e.driver_id, e.team_id,
           e.shown_class_total - e.shown_class_points as team_points, e.shown_class_position
    from entries e
    where not e.dsq and e.team_id is not null
    union all
    -- Delta Team: Delta rows by class total, for seasons that run it.
    select e.subsession_id, e.race_number, 'delta_team', e.driver_id, e.team_id,
           e.shown_class_total, e.shown_class_position
    from entries e
    where not e.dsq and e.team_id is not null and e.class_key = 'delta' and e.delta_team_enabled
  ),
  team_entries as (
    select
      se.subsession_id,
      se.race_number,
      se.slot,
      se.team_id,
      se.team_points,
      se.shown_class_position,
      row_number() over (
        partition by se.subsession_id, se.race_number, se.slot, se.team_id
        order by se.team_points desc, se.shown_class_position nulls last, se.driver_id
      ) as rank_in_team
    from slot_entries se
  ),
  team_scores as (
    select
      t.subsession_id,
      t.race_number,
      t.slot,
      t.team_id,
      sum(t.team_points) as score,
      max(t.team_points) as best_row,
      min(t.shown_class_position) as best_position
    from team_entries t
    where t.rank_in_team <= 2
    group by t.subsession_id, t.race_number, t.slot, t.team_id
  ),
  team_winners as (
    select distinct on (ts.subsession_id, ts.race_number, ts.slot)
      ts.subsession_id, ts.race_number, ts.slot, ts.team_id, tm.name as team_name, tm.logo_url as team_logo_url
    from team_scores ts
    join public.teams tm on tm.id = ts.team_id
    order by ts.subsession_id, ts.race_number, ts.slot,
             ts.score desc, ts.best_row desc, ts.best_position nulls last, tm.name, ts.team_id
  ),
  winners as (
    select cw.subsession_id, cw.race_number, cw.slot, cw.driver_id, d.name as driver_name,
           coalesce(d.is_hidden, false) as driver_hidden,
           null::uuid as team_id, null::text as team_name, null::text as team_logo_url
    from class_winners cw
    left join public.drivers_shown d on d.id = cw.driver_id
    union all
    select tw.subsession_id, tw.race_number, tw.slot, null::uuid, null::text, null::boolean,
           tw.team_id, tw.team_name, tw.team_logo_url
    from team_winners tw
  )
  select w.subsession_id, w.race_number, w.slot, w.driver_id, w.driver_name, w.driver_hidden,
         w.team_id, w.team_name, w.team_logo_url
  from winners w
  order by w.subsession_id, w.race_number,
           array_position(array['alpha', 'gamma', 'delta', 'alpha_team', 'delta_team'], w.slot);
end;
$$;

comment on function public.race_winners_for_rounds(bigint[]) is
  'Per race of the given rounds (at most 200): the Alpha, Gamma and Delta class winners and the Alpha Team and Delta Team winners, from race_score_results_public with names from drivers_shown (Race Results list).';

revoke all on function public.race_winners_for_rounds(bigint[]) from public, anon, authenticated, service_role;
grant execute on function public.race_winners_for_rounds(bigint[]) to anon, authenticated, service_role;
