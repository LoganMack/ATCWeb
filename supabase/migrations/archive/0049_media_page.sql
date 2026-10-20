-- Alpha Touring Challenge — Media page (videos/graphics/meetups)
--
-- Videos tab has five filters on the public /media page: Broadcasts is
-- derived entirely from existing data (race_links.broadcast_url, joined to
-- curated_rounds for track/date context — see getAllBroadcastLinks in
-- src/lib/supabase.ts), so it needs no table of its own. Track Guide is
-- one URL per circuit_layouts row (below), also not its own table. Only
-- the three admin-curated categories (cinematics, educational, other) need
-- a table, and they share one (media_videos.category) rather than three
-- near-identical tables.

alter table circuit_layouts
  add column if not exists track_guide_url text;

comment on column circuit_layouts.track_guide_url is
  'YouTube link to an admin-recorded track guide for this specific layout. Shown on the public Circuits page and as the "Track Guide" filter on the Media page''s Videos tab.';

create table if not exists media_videos (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('cinematic', 'educational', 'other')),
  title text not null,
  youtube_url text not null,
  created_at timestamptz not null default now()
);

create index if not exists media_videos_category_idx on media_videos (category, created_at desc);

alter table media_videos enable row level security;

drop policy if exists "public read" on media_videos;
create policy "public read" on media_videos for select using (true);

drop policy if exists "admin write media_videos" on media_videos;
create policy "admin write media_videos" on media_videos for insert with check (is_admin());

drop policy if exists "admin update media_videos" on media_videos;
create policy "admin update media_videos" on media_videos for update using (is_admin());

drop policy if exists "admin delete media_videos" on media_videos;
create policy "admin delete media_videos" on media_videos for delete using (is_admin());

create table if not exists media_graphics (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  image_url text not null,
  created_at timestamptz not null default now()
);

create index if not exists media_graphics_created_idx on media_graphics (created_at desc);

alter table media_graphics enable row level security;

drop policy if exists "public read" on media_graphics;
create policy "public read" on media_graphics for select using (true);

drop policy if exists "admin write media_graphics" on media_graphics;
create policy "admin write media_graphics" on media_graphics for insert with check (is_admin());

drop policy if exists "admin update media_graphics" on media_graphics;
create policy "admin update media_graphics" on media_graphics for update using (is_admin());

drop policy if exists "admin delete media_graphics" on media_graphics;
create policy "admin delete media_graphics" on media_graphics for delete using (is_admin());

-- latitude/longitude are admin-entered directly (no geocoding step) — kept
-- as plain numbers rather than a PostGIS point since this app has no other
-- geo data and the public page only ever needs to drop pins on a map, never
-- run spatial queries.
create table if not exists media_meetups (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  photo_url text,
  latitude double precision not null,
  longitude double precision not null,
  location_label text,
  meetup_date date,
  created_at timestamptz not null default now()
);

create index if not exists media_meetups_created_idx on media_meetups (created_at desc);

alter table media_meetups enable row level security;

drop policy if exists "public read" on media_meetups;
create policy "public read" on media_meetups for select using (true);

drop policy if exists "admin write media_meetups" on media_meetups;
create policy "admin write media_meetups" on media_meetups for insert with check (is_admin());

drop policy if exists "admin update media_meetups" on media_meetups;
create policy "admin update media_meetups" on media_meetups for update using (is_admin());

drop policy if exists "admin delete media_meetups" on media_meetups;
create policy "admin delete media_meetups" on media_meetups for delete using (is_admin());
