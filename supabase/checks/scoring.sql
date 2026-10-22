-- Live invariants for database-owned race scoring (unit scoring-ownership, W7). Read-only.
--
-- Run against production only with the owner's OK, in the Supabase SQL editor or with
--   psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/checks/scoring.sql
-- as the postgres role (score_round_preview allows it; the concealment check switches to anon
-- inside a transaction that is rolled back).
--
-- Every query returns violating rows only: an empty result from each of the five means the
-- invariants hold. Each row names its check in the first column.

-- 1. Recompute (freshness): what score_round_preview computes now equals what is stored, for
--    every round. It catches a stale round whatever input changed (BR1.1, BR3.1).
select 'recompute' as check, cr.subsession_id, d.differing_rows
from public.curated_rounds cr
cross join lateral (
  select count(*) as differing_rows from (
    (select to_jsonb(p) - 'scored_at' from public.score_round_preview(cr.subsession_id, '{}'::jsonb) p
     except
     select to_jsonb(r) - 'scored_at' from public.race_score_results r where r.subsession_id = cr.subsession_id)
    union all
    (select to_jsonb(r) - 'scored_at' from public.race_score_results r where r.subsession_id = cr.subsession_id
     except
     select to_jsonb(p) - 'scored_at' from public.score_round_preview(cr.subsession_id, '{}'::jsonb) p)
  ) x
) d
where d.differing_rows > 0
order by cr.subsession_id;

-- 2. Positions (BR2.3): ranked final positions are unique and within 1..n, and a race with no
--    effective time penalty keeps final = raw. n counts every entrant of the race, rostered or
--    not and DSQ'd or not: a DSQ'd driver keeps their finishing slot, so ranked positions can run
--    up to the full field size.
with entrants as (
  select rr.subsession_id, rr.race_number, count(*) as n
  from public.curated_race_results rr
  group by rr.subsession_id, rr.race_number
),
timed as (
  select p.subsession_id,
         case when p.session_type = 'race' then p.race_number else 1 end as race_number,
         p.driver_id
  from public.penalties p
  where p.driver_id is not null
  group by 1, 2, 3
  having sum(coalesce(case when p.is_appealed then p.appeal_time_penalty_seconds else p.time_penalty_seconds end, 0)) <> 0
)
select 'positions' as check, r.subsession_id, r.race_number, r.driver_id, r.raw_position, r.final_position,
       case
         when r.final_position < 1 or r.final_position > e.n then 'final position outside 1..n'
         when count(*) over (partition by r.subsession_id, r.race_number, r.final_position) > 1
           then 'duplicate final position'
         else 'final differs from raw with no time penalty in the race'
       end as problem
from public.race_score_results r
left join entrants e on e.subsession_id = r.subsession_id and e.race_number = r.race_number
where not r.dsq
  and (
    r.final_position is null
    or r.final_position < 1 or r.final_position > coalesce(e.n, 0)
    or exists (
      select 1 from public.race_score_results r2
      where r2.subsession_id = r.subsession_id and r2.race_number = r.race_number
        and r2.final_position = r.final_position and r2.driver_id <> r.driver_id)
    or (r.final_position is distinct from r.raw_position
        and not exists (
          select 1 from timed t
          join public.race_score_results r3
            on r3.subsession_id = t.subsession_id and r3.race_number = t.race_number and r3.driver_id = t.driver_id
          where t.subsession_id = r.subsession_id and t.race_number = r.race_number and not r3.dsq))
  )
order by r.subsession_id, r.race_number, r.final_position;

-- 3. Totals (BR2.5, BR2.6): both totals match their formulas and the deduction is not negative.
select 'totals' as check, r.subsession_id, r.race_number, r.driver_id,
       r.raw_overall_total, r.raw_class_total, r.final_points_deduction, r.final_overall_total, r.final_class_total
from public.race_score_results r
where r.final_points_deduction < 0
   or r.raw_class_total <> r.raw_finish_points + r.raw_class_points + r.raw_finesse_bonus + r.raw_pole_bonus
                          + r.raw_aggression_bonus + r.raw_lap_led_bonus + r.raw_fewest_incidents_bonus
                          + r.raw_fastest_lap_bonus + r.raw_sprint_sweep_bonus
   or r.raw_overall_total <> r.raw_class_total - r.raw_class_points
   or r.final_class_total <> r.final_finish_points + r.final_class_points + r.final_finesse_bonus + r.final_pole_bonus
                            + r.final_aggression_bonus + r.final_lap_led_bonus + r.final_fewest_incidents_bonus
                            + r.final_fastest_lap_bonus + r.final_sprint_sweep_bonus - r.final_points_deduction
   or r.final_overall_total <> r.final_class_total - r.final_class_points
order by r.subsession_id, r.race_number;

-- 4. Concealment (BR4.1): read as anon through the view, an unposted round shows the raw set,
--    no deduction and no penalised row.
begin;
set local role anon;
select 'concealment' as check, v.subsession_id, v.race_number, v.driver_id, v.shown_set,
       v.shown_points_deduction, v.shown_penalised
from public.race_score_results_public v
where not exists (
        select 1 from public.round_incident_status s where s.subsession_id = v.subsession_id and s.posted)
  and (v.shown_set <> 'raw' or v.shown_points_deduction <> 0 or v.shown_penalised)
order by v.subsession_id, v.race_number;
rollback;

-- 5. Coverage (BR3.5): every round with a result from a rostered driver has stored rows or an
--    open scoring_issues row.
select 'coverage' as check, cr.subsession_id, cr.season_id
from public.curated_rounds cr
where exists (
        select 1 from public.curated_race_results rr
        join public.drivers d on d.iracing_cust_id = rr.cust_id
        where rr.subsession_id = cr.subsession_id)
  and not exists (select 1 from public.race_score_results r where r.subsession_id = cr.subsession_id)
  and not exists (select 1 from public.scoring_issues si where si.subsession_id = cr.subsession_id)
order by cr.subsession_id;
