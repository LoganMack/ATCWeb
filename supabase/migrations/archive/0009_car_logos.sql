-- Alpha Touring Challenge — configurable car logos
--
-- Race results show which car a driver used as a small logo (Logan: "these
-- logos should function like the team logos"). The car itself is
-- `curated_race_results.car_name` (per-race, from the results pipeline —
-- NOT this repo's table, only read from). This table is this repo's own:
-- a simple car_name -> logo lookup an admin manages, independent of
-- whatever cars actually show up in the imported results. Keyed on the
-- car's name text itself (there's no separate numeric car id anywhere in
-- this schema) so it's a straightforward upsert-by-name, same shape as
-- champion_photos/race_links/round_overrides.
create table if not exists car_logos (
  car_name text primary key,
  logo_url text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists car_logos_set_updated_at on car_logos;
create trigger car_logos_set_updated_at before update on car_logos
  for each row execute function set_updated_at();

alter table car_logos enable row level security;

drop policy if exists "public read" on car_logos;
create policy "public read" on car_logos for select using (true);

drop policy if exists "admin write car_logos" on car_logos;
create policy "admin write car_logos" on car_logos for insert with check (is_admin());

drop policy if exists "admin update car_logos" on car_logos;
create policy "admin update car_logos" on car_logos for update using (is_admin());

drop policy if exists "admin delete car_logos" on car_logos;
create policy "admin delete car_logos" on car_logos for delete using (is_admin());
