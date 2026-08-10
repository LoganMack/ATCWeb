-- Alpha Touring Challenge — admin-manageable scoring rulesets
--
-- scoring_rulesets already existed (owns the rules jsonb recalculate_race_scores()
-- reads, and seasons.scoring_ruleset_id already links a season to one) but had
-- no admin UI and no way to mark one as "the default" for a season that
-- hasn't been assigned one yet. This adds exactly that:
--
-- - is_default: at most one true at a time (partial unique index below) —
--   the ruleset a season falls back to when its own scoring_ruleset_id is
--   null. Resolved app-side (src/lib/supabase.ts), not by any DB trigger —
--   a season's own column is left null on purpose so "unassigned, using
--   the default" stays a distinct, visible state from "explicitly assigned
--   this specific ruleset."
-- - updated_at: same set_updated_at() trigger convention as every other
--   admin-edited table.
--
-- RLS is unchanged — scoring_rulesets already had "public read rulesets"
-- plus admin insert/update/delete policies (public site never showed this
-- data before, but nothing prevented reading it; the new admin UI just
-- exercises the write policies that already existed).

alter table public.scoring_rulesets add column if not exists is_default boolean not null default false;
alter table public.scoring_rulesets add column if not exists updated_at timestamptz not null default now();

create unique index if not exists scoring_rulesets_one_default
  on public.scoring_rulesets (is_default)
  where is_default;

drop trigger if exists scoring_rulesets_set_updated_at on public.scoring_rulesets;
create trigger scoring_rulesets_set_updated_at before update on public.scoring_rulesets
  for each row execute function public.set_updated_at();
