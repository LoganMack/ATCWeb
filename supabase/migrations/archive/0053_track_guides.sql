-- Splits the single track_guide_url column on circuit_layouts into a proper
-- one-to-many table, so a layout can have any number of track guide videos
-- instead of just one.

create table public.track_guides (
  id uuid primary key default gen_random_uuid(),
  layout_id uuid not null references public.circuit_layouts(id) on delete cascade,
  title text,
  url text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index track_guides_layout_id_idx on public.track_guides(layout_id);

comment on table public.track_guides is 'One or more YouTube track guide videos per circuit_layouts row — replaces the old single circuit_layouts.track_guide_url column (see this migration). Shown grouped by layout on the public Media page''s Track Guide filter and managed per-layout on the admin Circuits page.';

alter table public.track_guides enable row level security;
create policy "public read" on public.track_guides for select using (true);
create policy "admin write track_guides" on public.track_guides for insert with check (is_admin());
create policy "admin update track_guides" on public.track_guides for update using (is_admin());
create policy "admin delete track_guides" on public.track_guides for delete using (is_admin());

-- Backfill: one row per layout that already had a guide URL on file.
insert into public.track_guides (layout_id, url)
select id, track_guide_url from public.circuit_layouts where track_guide_url is not null;

-- Clean cut-over — nothing else reads this column once the app code updates.
alter table public.circuit_layouts drop column track_guide_url;
