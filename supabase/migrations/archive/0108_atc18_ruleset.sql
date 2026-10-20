-- New scoring ruleset "ATC18": an exact copy of "ATC 17-18" except it allows
-- 3 drop weeks (rules.drops.base = 3) instead of 2.
--
-- Not the default ruleset and not assigned to any season; pick it on the
-- season (Admin > Seasons) when you want ATC18 to use it. Safe to re-run.

insert into public.scoring_rulesets (name, rules, is_default, can_drop_final_round)
select 'ATC18',
       jsonb_set(src.rules, '{drops,base}', '3'::jsonb),
       false,
       src.can_drop_final_round
  from public.scoring_rulesets src
 where src.name = 'ATC 17-18'
   and not exists (select 1 from public.scoring_rulesets where name = 'ATC18');
