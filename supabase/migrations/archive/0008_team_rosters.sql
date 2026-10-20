-- Alpha Touring Challenge — season-scoped team rosters
--
-- teams.id / drivers.id are shared across every season, but who actually
-- drove for a team changes every season (Logan: "we will need the ability
-- to track the roster of every team, active or inactive, on a per season
-- basis. They change every season."). This table is the join between a
-- team and the drivers on its roster for one specific season.
--
-- Two business rules enforced server-side (not just in the admin UI), via
-- the trigger below:
--   1. A team can carry at most 4 drivers in a season. The format's current
--      cap is 3, but it used to be 4 — capping at the historical max (4)
--      keeps older seasons' real rosters representable rather than forcing
--      a schema change if the cap is ever raised again.
--   2. A driver can only be on one team's roster per season.
--
-- Like champion_photos/round_overrides/race_links, this table IS owned by
-- this repo — teams/drivers/seasons themselves are this repo's own tables
-- (see 0001_init.sql), not part of the external results pipeline.
create table if not exists team_rosters (
  season_id uuid not null references seasons (id) on delete cascade,
  team_id uuid not null references teams (id) on delete cascade,
  driver_id uuid not null references drivers (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (season_id, team_id, driver_id)
);

create index if not exists team_rosters_season_idx on team_rosters (season_id);
create index if not exists team_rosters_team_idx on team_rosters (team_id);

create or replace function enforce_team_roster_limits()
returns trigger as $$
begin
  if (select count(*) from team_rosters where season_id = new.season_id and team_id = new.team_id) >= 4 then
    raise exception 'A team roster can have at most 4 drivers in a season.';
  end if;
  if exists (
    select 1 from team_rosters
    where season_id = new.season_id and driver_id = new.driver_id and team_id <> new.team_id
  ) then
    raise exception 'This driver is already on another team''s roster for this season.';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists team_rosters_enforce_limits on team_rosters;
create trigger team_rosters_enforce_limits
  before insert on team_rosters
  for each row execute function enforce_team_roster_limits();

alter table team_rosters enable row level security;

drop policy if exists "public read" on team_rosters;
create policy "public read" on team_rosters for select using (true);

drop policy if exists "admin write team_rosters" on team_rosters;
create policy "admin write team_rosters" on team_rosters for insert with check (is_admin());

drop policy if exists "admin delete team_rosters" on team_rosters;
create policy "admin delete team_rosters" on team_rosters for delete using (is_admin());
