-- Tagged drivers on a news post — same many-to-many join-table shape as
-- news_post_tags (0055_news_tags.sql), just against `drivers` instead of a
-- separate `news_tags` table (there's no admin-managed vocabulary to
-- maintain here, so no news_drivers table is needed — the driver themself
-- IS the tag). Synced with a delete-all-then-insert on save (see
-- setPostDrivers() in src/lib/supabase.ts), same approach setPostTags()
-- already uses for news_post_tags.
--
-- Powers two things: the driver-name links shown on a news post
-- (src/pages/news/[slug].astro), and the "Related News" section on a
-- driver's own profile page (src/pages/drivers/[id]/fragment.astro), which
-- also independently pulls in any post whose linked round
-- (news_posts.round_subsession_id) is a round this driver actually raced —
-- this table only covers the EXPLICIT tag side of that, not the
-- linked-round side.
create table public.news_post_drivers (
  post_id uuid not null references public.news_posts(id) on delete cascade,
  driver_id uuid not null references public.drivers(id) on delete cascade,
  primary key (post_id, driver_id)
);

create index if not exists news_post_drivers_driver_idx on public.news_post_drivers (driver_id);

alter table public.news_post_drivers enable row level security;
create policy "public read" on public.news_post_drivers for select using (true);
create policy "admin write news_post_drivers" on public.news_post_drivers for insert with check (is_admin());
create policy "admin delete news_post_drivers" on public.news_post_drivers for delete using (is_admin());
