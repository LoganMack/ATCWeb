-- Alpha Touring Challenge — hall_of_fame_photos
--
-- Up to 5 uploaded photos per Hall of Fame member, shown on the public
-- /hall-of-fame page using the same "1 large + 2x2 small" grid the
-- Champions page uses (see src/components/PhotoGrid.astro, shared by both
-- ChampionCard.astro and hall-of-fame.astro). Scoped to just driver_id —
-- unlike champion_photos (which is keyed per season+class, since a driver
-- can be a champion multiple times), Hall of Fame membership is a single
-- per-driver flag (drivers.is_hall_of_fame, 0027_hall_of_fame.sql), so one
-- set of up to 5 photos per driver is enough.
create table hall_of_fame_photos (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references drivers(id) on delete cascade,
  image_url text not null,
  sort_order int not null default 0 check (sort_order >= 0 and sort_order < 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hall_of_fame_photos_unique_slot unique (driver_id, sort_order)
);

create index hall_of_fame_photos_driver_idx on hall_of_fame_photos (driver_id);

create trigger hall_of_fame_photos_set_updated_at before update on hall_of_fame_photos
  for each row execute function set_updated_at();

alter table hall_of_fame_photos enable row level security;

create policy "public read" on hall_of_fame_photos for select using (true);
create policy "admin write hall_of_fame_photos" on hall_of_fame_photos for insert with check (is_admin());
create policy "admin update hall_of_fame_photos" on hall_of_fame_photos for update using (is_admin());
create policy "admin delete hall_of_fame_photos" on hall_of_fame_photos for delete using (is_admin());
