-- Alpha Touring Challenge — historical team logos, per season
--
-- Teams have rebranded across their history; results/standings/news recaps
-- for a past season should show what the team looked like *then*, not
-- today's current logo. Normal child table of both `teams` and `seasons`
-- (both this repo's own, see 0001_init.sql) — this repo already owns
-- `teams.logo_url` as "the current logo," so this is just an optional
-- per-season override on top of it, one row per (team, season).
--
-- A season with no row here falls back to the team's current logo
-- (`teams.logo_url`) — see src/lib/results.ts's resolveTeamLogo(), used
-- everywhere a team's logo is shown alongside a specific season's
-- results/standings (round results, news round-recaps, the standings
-- page's per-driver team-usage rows).
--
-- Deliberately a separate table (and separate uploaded files, see
-- src/pages/admin/teams/[id].astro) rather than reusing/overwriting
-- `teams.logo_url` — so uploading a new *current* logo can never clobber a
-- season's historical one, and vice versa.
create table if not exists team_season_logos (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams (id) on delete cascade,
  season_id uuid not null references seasons (id) on delete cascade,
  logo_url text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, season_id)
);

create index if not exists team_season_logos_team_idx on team_season_logos (team_id);
create index if not exists team_season_logos_season_idx on team_season_logos (season_id);

drop trigger if exists team_season_logos_set_updated_at on team_season_logos;
create trigger team_season_logos_set_updated_at before update on team_season_logos
  for each row execute function set_updated_at();

alter table team_season_logos enable row level security;

drop policy if exists "public read" on team_season_logos;
create policy "public read" on team_season_logos for select using (true);

drop policy if exists "admin write team_season_logos" on team_season_logos;
create policy "admin write team_season_logos" on team_season_logos for insert with check (is_admin());

drop policy if exists "admin update team_season_logos" on team_season_logos;
create policy "admin update team_season_logos" on team_season_logos for update using (is_admin());

drop policy if exists "admin delete team_season_logos" on team_season_logos;
create policy "admin delete team_season_logos" on team_season_logos for delete using (is_admin());
