-- Alpha Touring Challenge — initial schema
-- Design goals: normalized lookups so new statuses/classes/teams/seasons can be
-- added later without schema changes; RLS on from day one since Supabase
-- exposes every table over a public REST/GraphQL API by default.

create extension if not exists pgcrypto; -- for gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Lookup tables
-- ---------------------------------------------------------------------------

create table driver_statuses (
  id serial primary key,
  name text not null unique,
  sort_order int not null default 0
);

insert into driver_statuses (name, sort_order) values
  ('Active', 1),
  ('Veteran', 2),
  ('New', 3),
  ('Inactive', 4);

create table driver_classes (
  id serial primary key,
  name text not null unique,
  sort_order int not null default 0
);

-- Order reflects competitive tier, top to bottom. Adjust sort_order any time
-- without a migration if the tier ranking changes.
insert into driver_classes (name, sort_order) values
  ('Alpha', 1),
  ('Gamma', 2),
  ('Delta', 3);

-- ---------------------------------------------------------------------------
-- Seasons (one row per season, e.g. ATC15-ATC18). Each season can carry its
-- own logo per your season-to-season branding refresh.
-- ---------------------------------------------------------------------------

create table seasons (
  id uuid primary key default gen_random_uuid(),
  number int not null unique,           -- 17, 18, ...
  name text not null,                    -- "ATC18"
  logo_url text,
  start_date date,
  end_date date,
  is_current boolean not null default false,
  created_at timestamptz not null default now()
);

-- Only one season may be marked current at a time.
create unique index one_current_season on seasons (is_current) where is_current;

-- ---------------------------------------------------------------------------
-- Teams
-- ---------------------------------------------------------------------------

create table teams (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  primary_color_hex text,   -- e.g. '#1F5EDA' — optional, for future team-color theming
  logo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Drivers
-- ---------------------------------------------------------------------------

create table drivers (
  id uuid primary key default gen_random_uuid(),
  car_number int,                         -- nullable: some drivers are unassigned a number
  name text not null unique,              -- roster naturally disambiguates duplicate real names (e.g. "John Daniels3")
  status_id int not null references driver_statuses(id),
  class_id int not null references driver_classes(id),
  team_id uuid references teams(id) on delete set null,
  is_rookie boolean not null default false,
  car text,                                -- free text, e.g. "Honda Civic"; null/'N/A' both allowed
  appearances int not null default 0,
  starts int not null default 0,
  seasons_count int not null default 0,    -- career seasons competed (not fk to `seasons`)
  penalty_points int not null default 0,
  penalty_points_max int not null default 11,
  photo_url text,                          -- reserved for future headshots
  bio text,                                -- reserved for future driver bios
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index drivers_status_idx on drivers (status_id);
create index drivers_class_idx on drivers (class_id);
create index drivers_team_idx on drivers (team_id);

-- ---------------------------------------------------------------------------
-- News posts
-- ---------------------------------------------------------------------------

create table news_posts (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  excerpt text,
  body text not null,                      -- markdown
  cover_image_url text,
  author_name text not null,
  status text not null default 'published' check (status in ('draft', 'published')),
  season_id uuid references seasons(id) on delete set null,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index news_posts_published_idx on news_posts (published_at desc) where status = 'published';

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger teams_set_updated_at before update on teams
  for each row execute function set_updated_at();

create trigger drivers_set_updated_at before update on drivers
  for each row execute function set_updated_at();

create trigger news_posts_set_updated_at before update on news_posts
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- Public (anon) key can READ published content. All writes are blocked from
-- the anon/public role — do edits via the Supabase Table Editor (as the
-- postgres/service role) or a future authenticated admin panel.
-- ---------------------------------------------------------------------------

alter table driver_statuses enable row level security;
alter table driver_classes enable row level security;
alter table seasons enable row level security;
alter table teams enable row level security;
alter table drivers enable row level security;
alter table news_posts enable row level security;

create policy "public read" on driver_statuses for select using (true);
create policy "public read" on driver_classes for select using (true);
create policy "public read" on seasons for select using (true);
create policy "public read" on teams for select using (true);
create policy "public read" on drivers for select using (true);

create policy "public read published news" on news_posts
  for select using (status = 'published');

-- No insert/update/delete policies are defined for anon/authenticated roles,
-- which means the public API can only ever read. Writes must go through the
-- Supabase dashboard (service role) or a server-side key you never expose
-- to the browser.
