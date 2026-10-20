-- Alpha Touring Challenge — circuit layouts (lap records)
--
-- A circuit can be run in more than one configuration (e.g. Full Course vs.
-- a shorter National/Club layout), and each configuration has its own lap
-- record. This repo owns `circuits` already (0001_init.sql); layouts are a
-- normal child table of it, this repo's own.
create table if not exists circuit_layouts (
  id uuid primary key default gen_random_uuid(),
  circuit_id uuid not null references circuits (id) on delete cascade,
  name text not null,
  length_km numeric,
  lap_record_time text,          -- "x:xx.xx" as typically quoted, not stored as an interval — see admin form for the expected format
  lap_record_holder text,
  lap_record_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists circuit_layouts_circuit_idx on circuit_layouts (circuit_id);

drop trigger if exists circuit_layouts_set_updated_at on circuit_layouts;
create trigger circuit_layouts_set_updated_at before update on circuit_layouts
  for each row execute function set_updated_at();

alter table circuit_layouts enable row level security;

drop policy if exists "public read" on circuit_layouts;
create policy "public read" on circuit_layouts for select using (true);

drop policy if exists "admin write circuit_layouts" on circuit_layouts;
create policy "admin write circuit_layouts" on circuit_layouts for insert with check (is_admin());

drop policy if exists "admin update circuit_layouts" on circuit_layouts;
create policy "admin update circuit_layouts" on circuit_layouts for update using (is_admin());

drop policy if exists "admin delete circuit_layouts" on circuit_layouts;
create policy "admin delete circuit_layouts" on circuit_layouts for delete using (is_admin());
