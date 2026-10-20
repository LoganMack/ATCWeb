-- Alpha Touring Challenge — per-season logos, and per-page banner images
--
-- Two small, unrelated additions bundled into one migration since they
-- landed in the same pass:
--
-- 1) `seasons.logo_url` already exists (see 0001_init.sql) but nothing has
--    ever been able to WRITE it — 0001 only ever granted "public read" on
--    seasons, no admin write/update policy at all. This adds the missing
--    admin update policy so /admin/seasons can actually set it. (Insert/
--    delete deliberately NOT granted — seasons themselves are still
--    created/removed outside this app, same as the pre-existing
--    extra_drop_weeks column noted in 0004_champions.sql; only the logo is
--    editable here.)
--
-- 2) A new `page_banners` table — one optional background image per public
--    page (keyed by a stable page_key the app defines, e.g. 'home',
--    'standings', 'roster' — see src/lib/pageBanners.ts), managed from a
--    new /admin/page-banners screen. Same shape/RLS pattern as car_logos
--    (0009_car_logos.sql): public read, admin write/update/delete, upsert
--    keyed on the natural key (page_key here, car_name there).

-- ---------------------------------------------------------------------------
-- seasons — admin can now update (for logo_url)
-- ---------------------------------------------------------------------------

create policy "admin update seasons" on seasons for update using (is_admin());

-- ---------------------------------------------------------------------------
-- page_banners
-- ---------------------------------------------------------------------------

create table if not exists page_banners (
  page_key text primary key,
  image_url text not null,
  updated_at timestamptz not null default now()
);

drop trigger if exists page_banners_set_updated_at on page_banners;
create trigger page_banners_set_updated_at before update on page_banners
  for each row execute function set_updated_at();

alter table page_banners enable row level security;

create policy "public read page_banners" on page_banners for select using (true);
create policy "admin write page_banners" on page_banners for insert with check (is_admin());
create policy "admin update page_banners" on page_banners for update using (is_admin());
create policy "admin delete page_banners" on page_banners for delete using (is_admin());

-- ---------------------------------------------------------------------------
-- Storage — a 'banners' bucket for the images above. Public read (so <img>/
-- background-image both just work), admin-only write — same pattern as the
-- 'logos'/'photos' buckets in 0002_auth_admin.sql.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('banners', 'banners', true)
on conflict (id) do nothing;

create policy "public read banners" on storage.objects for select using (bucket_id = 'banners');
create policy "admin write banners" on storage.objects for insert with check (bucket_id = 'banners' and is_admin());
create policy "admin update banners" on storage.objects for update using (bucket_id = 'banners' and is_admin());
create policy "admin delete banners" on storage.objects for delete using (bucket_id = 'banners' and is_admin());
