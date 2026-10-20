-- Alpha Touring Challenge — organizations sql
--
-- Some teams have gone through multiple name changes over ATC's history —
-- historically each rename created a brand-new `teams` row (teams.name is
-- unique, and there was never a "rename in place" workflow), which
-- fractures what a fan would consider one continuous team's career stats
-- across several disconnected team_id rows on Team Stats.
--
-- An `organization` is the persistent "this is really the same team"
-- identity that spans those renames. `organization_team_seasons` links an
-- organization to exactly one `teams` row for a given season (e.g. Org "Nova
-- Racing" -> team "Nova Racing" for ATC12-14, team "Apex Nova" for ATC15+).
-- A team that has never been renamed needs no organization row at all —
-- Team Stats (see computeTeamCareerStats in src/lib/results.ts) falls back
-- to treating every unlinked team as its own implicit single-team
-- organization, so this feature is fully opt-in per team.
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table organization_team_seasons (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  season_id uuid not null references seasons(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- One team per organization per season...
  constraint organization_team_seasons_one_team_per_org_season unique (organization_id, season_id),
  -- ...and a given team+season can only ever be claimed by one organization.
  constraint organization_team_seasons_one_org_per_team_season unique (team_id, season_id)
);

create index organization_team_seasons_org_idx on organization_team_seasons (organization_id);
create index organization_team_seasons_team_idx on organization_team_seasons (team_id);
create index organization_team_seasons_season_idx on organization_team_seasons (season_id);

create trigger organizations_set_updated_at before update on organizations
  for each row execute function set_updated_at();

alter table organizations enable row level security;
alter table organization_team_seasons enable row level security;

create policy "public read" on organizations for select using (true);
create policy "admin write organizations" on organizations for insert with check (is_admin());
create policy "admin update organizations" on organizations for update using (is_admin());
create policy "admin delete organizations" on organizations for delete using (is_admin());

create policy "public read" on organization_team_seasons for select using (true);
create policy "admin write organization_team_seasons" on organization_team_seasons for insert with check (is_admin());
create policy "admin update organization_team_seasons" on organization_team_seasons for update using (is_admin());
create policy "admin delete organization_team_seasons" on organization_team_seasons for delete using (is_admin());
