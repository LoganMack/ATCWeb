-- Alpha Touring Challenge — layout map details: incident pins and pit lane
--
-- The Event Briefing page's layout map can now show where past incidents
-- happened, and whether the pit entry and pit exit are tricky:
--
--   * layout_incident_pins: one pin per incident, placed by hand on the
--     layout's map in /admin/circuits/<id>/map/<layoutId>. x/y are percentages
--     of the map image (0-100, from the top-left), so a pin stays put at any
--     display size. The public page draws the pins, and a heat layer from
--     where they cluster.
--   * circuit_layouts.pit_entry_* / pit_exit_*: a difficulty ('easy' |
--     'moderate' | 'difficult'), a short optional note, and an optional point
--     on the map (shown as a flag on the desktop map). Entry and exit are
--     separate settings.
--
-- Pins are readable by everyone, like penalties themselves (0014); the public
-- page only draws pins for incidents whose round report has been posted.

alter table public.circuit_layouts
  add column if not exists pit_entry_difficulty text,
  add column if not exists pit_entry_note text,
  add column if not exists pit_entry_x numeric,
  add column if not exists pit_entry_y numeric,
  add column if not exists pit_exit_difficulty text,
  add column if not exists pit_exit_note text,
  add column if not exists pit_exit_x numeric,
  add column if not exists pit_exit_y numeric;

alter table public.circuit_layouts drop constraint if exists circuit_layouts_pit_entry_difficulty_check;
alter table public.circuit_layouts add constraint circuit_layouts_pit_entry_difficulty_check
  check (pit_entry_difficulty is null or pit_entry_difficulty in ('easy', 'moderate', 'difficult'));
alter table public.circuit_layouts drop constraint if exists circuit_layouts_pit_exit_difficulty_check;
alter table public.circuit_layouts add constraint circuit_layouts_pit_exit_difficulty_check
  check (pit_exit_difficulty is null or pit_exit_difficulty in ('easy', 'moderate', 'difficult'));
alter table public.circuit_layouts drop constraint if exists circuit_layouts_pit_points_check;
alter table public.circuit_layouts add constraint circuit_layouts_pit_points_check check (
  (pit_entry_x is null or pit_entry_x between 0 and 100) and (pit_entry_y is null or pit_entry_y between 0 and 100)
  and (pit_exit_x is null or pit_exit_x between 0 and 100) and (pit_exit_y is null or pit_exit_y between 0 and 100)
);

create table if not exists public.layout_incident_pins (
  id uuid primary key default gen_random_uuid(),
  layout_id uuid not null references public.circuit_layouts(id) on delete cascade,
  -- One pin per incident; deleting the incident removes its pin.
  penalty_id uuid not null unique references public.penalties(id) on delete cascade,
  x numeric not null check (x between 0 and 100),
  y numeric not null check (y between 0 and 100),
  created_at timestamptz not null default now()
);

create index if not exists layout_incident_pins_layout_id_idx on public.layout_incident_pins(layout_id);

comment on table public.layout_incident_pins is 'Where an incident happened on its layout''s map — x/y are percentages (0-100) of the map image. Placed by an admin on /admin/circuits/<id>/map/<layoutId>; drawn (and turned into a heat layer) on the Event Briefing page''s layout map for posted incidents.';

alter table public.layout_incident_pins enable row level security;
drop policy if exists "public read layout_incident_pins" on public.layout_incident_pins;
create policy "public read layout_incident_pins" on public.layout_incident_pins for select using (true);
drop policy if exists "admin insert layout_incident_pins" on public.layout_incident_pins;
create policy "admin insert layout_incident_pins" on public.layout_incident_pins for insert with check (is_admin());
drop policy if exists "admin update layout_incident_pins" on public.layout_incident_pins;
create policy "admin update layout_incident_pins" on public.layout_incident_pins for update using (is_admin());
drop policy if exists "admin delete layout_incident_pins" on public.layout_incident_pins;
create policy "admin delete layout_incident_pins" on public.layout_incident_pins for delete using (is_admin());
