-- Alpha Touring Challenge — generic single-value site settings
--
-- A tiny key/value table for one-off, SITE-WIDE (not per-page) admin-
-- editable values — the thing page_banners (0024) is for per-page images,
-- this is for everything else that's just one value with no natural home
-- of its own. First use: 'featured_broadcast_url', the YouTube URL for the
-- homepage's new "Featured Broadcast" embed (see src/pages/index.astro),
-- set from /admin/site-settings (src/lib/siteSettings.ts has the key
-- constant + the youtube-URL-to-embed-URL parsing).
--
-- Same shape/RLS pattern as page_banners: public read, admin write/update/
-- delete, upsert keyed on the natural key (setting_key here).

create table if not exists site_settings (
  setting_key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

drop trigger if exists site_settings_set_updated_at on site_settings;
create trigger site_settings_set_updated_at before update on site_settings
  for each row execute function set_updated_at();

alter table site_settings enable row level security;

create policy "public read site_settings" on site_settings for select using (true);
create policy "admin write site_settings" on site_settings for insert with check (is_admin());
create policy "admin update site_settings" on site_settings for update using (is_admin());
create policy "admin delete site_settings" on site_settings for delete using (is_admin());
