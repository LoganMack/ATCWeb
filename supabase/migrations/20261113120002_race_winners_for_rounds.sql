-- Race winners for the public Race Results list (FR4.2, FR4.3, NFR1, NFR2; rules BR4.1-BR4.6 of the race
-- winners design).
--
-- What: public.race_winners_for_rounds(p_subsession_ids) returns, for every race of the given rounds, up to
-- five winners in slot order: the Alpha, Gamma and Delta class winners (drivers) and the Alpha Team and Delta
-- Team winners (teams).
--   * A class winner is the classified, non-disqualified driver of that class with the best shown class
--     position (lowest driver id on an unexpected tie).
--   * A team's race score is the sum of its two best rows in the slot's class, as the team championship and
--     the homepage Previous Result widget count it: Alpha Team uses class total minus class points (Alpha
--     teams are scored class-blind), Delta Team the class total. Highest score wins; ties go to the better
--     best row, then the better best class position, then the team name.
--   * The Delta Team slot exists only for seasons with delta_team_enabled. No finisher means no slot.
--
-- Why one function: the Race Results page must stay within the Worker's 10 ms CPU budget, so it asks for the
-- winners of every listed round in one call and gets ready-made rows back (at most 5 per race). It refuses
-- more than 200 rounds per call.
--
-- Why security invoker: it reads only views and tables that are already safe for anon. race_score_results_public
-- shows the raw set until a round's incident report is posted and the final set after (all of it for admins),
-- and drivers_shown masks hidden drivers' names for this caller, so the winners follow the same rules as every
-- other results page.
--
-- Expand only: a new function that the code on main never calls. Undo with
-- supabase/down/20261113120002_race_winners_for_rounds.down.sql.

create function public.race_winners_for_rounds(p_subsession_ids bigint[])
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
    select
      r.subsession_id,
      r.race_number,
      r.driver_id,
      r.team_id,
      r.dsq,
      r.classified,
      r.shown_class_position,
      case when lower(c.name) = 'alpha' then r.shown_class_total - r.shown_class_points
           else r.shown_class_total end as team_points,
      lower(c.name) as class_key,
      coalesce(s.delta_team_enabled, false) as delta_team_enabled
    from public.race_score_results_public r
    join public.driver_classes c on c.id = r.class_id
    left join public.seasons s on s.id = r.season_id
    where r.subsession_id = any (p_subsession_ids)
      and lower(c.name) in ('alpha', 'gamma', 'delta')
  ),
  class_winners as (
    select distinct on (e.subsession_id, e.race_number, e.class_key)
      e.subsession_id, e.race_number, e.class_key as slot, e.driver_id
    from entries e
    where not e.dsq and e.classified and e.shown_class_position is not null
    order by e.subsession_id, e.race_number, e.class_key, e.shown_class_position, e.driver_id
  ),
  team_entries as (
    select
      e.subsession_id,
      e.race_number,
      e.class_key || '_team' as slot,
      e.team_id,
      e.team_points,
      e.shown_class_position,
      row_number() over (
        partition by e.subsession_id, e.race_number, e.class_key, e.team_id
        order by e.team_points desc, e.shown_class_position nulls last, e.driver_id
      ) as rank_in_team
    from entries e
    where not e.dsq
      and e.team_id is not null
      and (e.class_key = 'alpha' or (e.class_key = 'delta' and e.delta_team_enabled))
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
