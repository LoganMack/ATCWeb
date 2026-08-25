-- Alpha Touring Challenge — manual_awards
--
-- Two of the Awards page's entries — Best Racecraft and Most Improved — are
-- steward judgment calls, not something derivable from race_scores/
-- curated_race_results the way the other twelve awards are (see
-- computeSeasonAwardsHistory in src/lib/results.ts, which computes all
-- twelve of those from imported results data). This table just records who
-- won each, per season, entered by hand in Admin > Awards — there's no
-- "recalculate" for this table, an admin's pick IS the data.
--
-- Same "ties are shared, never arbitrarily broken" convention every computed
-- award on the Awards page already follows (see results.ts's own header
-- comment on that section) — more than one winner for a (season_id,
-- award_key) pair is just more than one row, same shape team_rosters
-- (0008_team_rosters.sql) already uses to let one (season, team) pair carry
-- several driver rows.
create table if not exists manual_awards (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references seasons (id) on delete cascade,
  award_key text not null check (award_key in ('best_racecraft', 'most_improved')),
  driver_id uuid not null references drivers (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint manual_awards_unique_winner unique (season_id, award_key, driver_id)
);

create index if not exists manual_awards_season_idx on manual_awards (season_id);
create index if not exists manual_awards_season_award_idx on manual_awards (season_id, award_key);

alter table manual_awards enable row level security;

drop policy if exists "public read" on manual_awards;
create policy "public read" on manual_awards for select using (true);

-- Insert/delete only, no update policy — same as team_rosters: changing a
-- pick is "remove the old winner, add the new one," not an in-place edit.
drop policy if exists "admin write manual_awards" on manual_awards;
create policy "admin write manual_awards" on manual_awards for insert with check (is_admin());

drop policy if exists "admin delete manual_awards" on manual_awards;
create policy "admin delete manual_awards" on manual_awards for delete using (is_admin());
