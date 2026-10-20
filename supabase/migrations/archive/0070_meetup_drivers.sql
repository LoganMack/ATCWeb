-- Alpha Touring Challenge — drivers attached to a meetup
--
-- Per Logan: the public Media page's Meetups map pin popup should be able to
-- show which roster drivers actually showed up to a given meetup. Plain
-- many-to-many join table (no extra columns of its own needed — just "this
-- driver was at this meetup") between media_meetups (0049_media_page.sql)
-- and drivers. Admin-managed as its own add/remove mini-list on the Meetups
-- section of Admin -> Media, independent of a meetup's own title/photo/
-- location form — same pattern track_guides (0053_track_guides.sql) already
-- uses for "one-to-many extra list, managed separately from the parent
-- row's own edit form."
create table if not exists media_meetup_drivers (
  meetup_id uuid not null references media_meetups(id) on delete cascade,
  driver_id uuid not null references drivers(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (meetup_id, driver_id)
);

create index if not exists media_meetup_drivers_driver_idx on media_meetup_drivers (driver_id);

alter table media_meetup_drivers enable row level security;

drop policy if exists "public read" on media_meetup_drivers;
create policy "public read" on media_meetup_drivers for select using (true);

drop policy if exists "admin write media_meetup_drivers" on media_meetup_drivers;
create policy "admin write media_meetup_drivers" on media_meetup_drivers for insert with check (is_admin());

drop policy if exists "admin delete media_meetup_drivers" on media_meetup_drivers;
create policy "admin delete media_meetup_drivers" on media_meetup_drivers for delete using (is_admin());
