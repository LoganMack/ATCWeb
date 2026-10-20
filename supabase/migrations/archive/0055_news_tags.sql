-- Manageable news tags (in addition to the display-only "RESULTS" tag,
-- which is derived from news_posts.round_subsession_id and needs no table
-- of its own — see 0017_news_round_season.sql). news_post_tags is a plain
-- many-to-many join table, synced with a delete-all-then-insert on save
-- (see setPostTags() in src/lib/supabase.ts), same approach
-- setOrganizationTeamForSeason() already uses for its own many-to-many
-- join table (0043_organizations.sql).
create table public.news_tags (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table public.news_post_tags (
  post_id uuid not null references public.news_posts(id) on delete cascade,
  tag_id uuid not null references public.news_tags(id) on delete cascade,
  primary key (post_id, tag_id)
);

alter table public.news_tags enable row level security;
create policy "public read" on public.news_tags for select using (true);
create policy "admin write news_tags" on public.news_tags for insert with check (is_admin());
create policy "admin update news_tags" on public.news_tags for update using (is_admin());
create policy "admin delete news_tags" on public.news_tags for delete using (is_admin());

alter table public.news_post_tags enable row level security;
create policy "public read" on public.news_post_tags for select using (true);
create policy "admin write news_post_tags" on public.news_post_tags for insert with check (is_admin());
create policy "admin delete news_post_tags" on public.news_post_tags for delete using (is_admin());
