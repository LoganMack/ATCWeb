-- Undoes 20261123120000_layout_category_and_logo_colour.sql: clears custom logo colours, restores the
-- light/dark-only logo CHECK, puts circuit_layouts_shown back as 20261029120000_driver_privacy_views.sql
-- defined it, then drops circuit_layouts.category.
--
-- Data loss, on purpose: custom #rrggbb logo colours become null (no plate) and every layout category is
-- dropped, because the old schema cannot hold them.
--
-- The view is dropped and recreated because create or replace cannot remove a column.

-- 1. Custom colours out, so the old CHECK can come back ------------------------------------------------
update public.circuits set logo_background = null where logo_background like '#%';

-- 2. The logo CHECK as the baseline defines it ---------------------------------------------------------
alter table public.circuits drop constraint circuits_logo_background_check;
alter table public.circuits add constraint circuits_logo_background_check
  check (logo_background is null or logo_background = any (array['light'::text, 'dark'::text]));

-- 3. The view as 20261029120000 defined it, with its comment and select-only grants --------------------
drop view public.circuit_layouts_shown;

create view public.circuit_layouts_shown with (security_invoker = false, security_barrier = true) as
select
  c.id,
  c.circuit_id,
  c.name,
  c.length_km,
  case
    -- Whitespace runs are collapsed on both sides, as in mask_names.
    when regexp_replace(lower(btrim(c.lap_record_holder)), '[[:space:]]+', ' ', 'g') = any (array(
      select regexp_replace(lower(btrim(h.full_name)), '[[:space:]]+', ' ', 'g') from private.hidden_drivers h where h.name_hidden
    )) then 'Hidden Driver'
    else c.lap_record_holder
  end as lap_record_holder,
  c.lap_record_date,
  c.created_at,
  c.updated_at,
  c.lap_record_seconds,
  c.image_url,
  c.corners,
  c.pit_entry_difficulty,
  c.pit_entry_note,
  c.pit_entry_x,
  c.pit_entry_y,
  c.pit_exit_difficulty,
  c.pit_exit_note,
  c.pit_exit_x,
  c.pit_exit_y
from public.circuit_layouts c;

comment on view public.circuit_layouts_shown is
  'circuit_layouts for pages (U4): a lap record holder equal to a hidden driver''s full name reads "Hidden Driver".';

revoke all on table public.circuit_layouts_shown from public, anon, authenticated, service_role;
grant select on table public.circuit_layouts_shown to anon, authenticated, service_role;

-- 4. The category column; its CHECK goes with it ------------------------------------------------------
alter table public.circuit_layouts drop column category;
