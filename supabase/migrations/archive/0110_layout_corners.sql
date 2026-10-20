-- Alpha Touring Challenge — numbered corner markers on a layout's map
--
-- The layout map editor (/admin/circuits/<id>/map/<layoutId>) lets an admin
-- mark where each corner/turn is on the map, with its label ("1", "10", "5a").
-- The Reported Incidents page uses them to circle the turn(s) a driver named in
-- an incident report. x/y are percentages of the (square) map image, like
-- layout_incident_pins (0106).

create table if not exists public.layout_corners (
  id uuid primary key default gen_random_uuid(),
  layout_id uuid not null references public.circuit_layouts(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 8),
  x numeric not null check (x between 0 and 100),
  y numeric not null check (y between 0 and 100),
  created_at timestamptz not null default now(),
  unique (layout_id, label)
);

create index if not exists layout_corners_layout_id_idx on public.layout_corners(layout_id);

comment on table public.layout_corners is 'Where a numbered corner is on its layout''s map — x/y are percentages (0-100) of the map image. Placed by an admin in the layout map editor; used to circle reported turns on the Reported Incidents page.';

alter table public.layout_corners enable row level security;
drop policy if exists "public read layout_corners" on public.layout_corners;
create policy "public read layout_corners" on public.layout_corners for select using (true);
drop policy if exists "admin insert layout_corners" on public.layout_corners;
create policy "admin insert layout_corners" on public.layout_corners for insert with check (is_admin());
drop policy if exists "admin update layout_corners" on public.layout_corners;
create policy "admin update layout_corners" on public.layout_corners for update using (is_admin());
drop policy if exists "admin delete layout_corners" on public.layout_corners;
create policy "admin delete layout_corners" on public.layout_corners for delete using (is_admin());
