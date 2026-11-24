-- Layout categories and custom circuit logo colours.
--
-- Why: the circuit editor needs to sort each layout into Oval, Roval, Road Course (Long), Road Course (Short)
-- or Street Course, so driver profiles can split results by track type; and some track logos need a plate
-- in their own colour rather than the fixed light or dark one.
--
-- What:
--   * circuit_layouts.category, nullable, limited to five keys. Labels live in src/lib/circuitCategory.ts.
--     Every row starts empty; a later data fix fills them in.
--   * circuits.logo_background now also accepts a lower-case #rrggbb colour, alongside light and dark.
--   * circuit_layouts_shown returns category as its last column. The rest of the view, its masking of a
--     hidden lap record holder, its options and its select-only grants are unchanged.
--
-- Writes stay admin-only through the existing circuit_layouts and circuits policies (row policies cover
-- every column), so no policy changes.
--
-- Expand-only: a new nullable column, a wider CHECK and one appended view column; the code on main keeps
-- working. One transaction: the Supabase CLI and CI apply each file in one.
-- Undo: supabase/down/20261123120000_layout_category_and_logo_colour.down.sql.

-- 1. The layout category -------------------------------------------------------------------------------
alter table public.circuit_layouts
  add column category text
  constraint circuit_layouts_category_check
    check (category is null or category in ('oval', 'roval', 'road_long', 'road_short', 'street'));

comment on column public.circuit_layouts.category is
  'Track type of this layout: oval, roval, road_long, road_short or street; null until set. Labels in src/lib/circuitCategory.ts.';

-- 2. Custom logo colours -------------------------------------------------------------------------------
--    Lower case only, so one colour has one spelling; the app normalises before saving.
alter table public.circuits drop constraint circuits_logo_background_check;
alter table public.circuits add constraint circuits_logo_background_check
  check (logo_background is null or logo_background in ('light', 'dark') or logo_background ~ '^#[0-9a-f]{6}$');

-- 3. The public view, with category appended -----------------------------------------------------------
--    Same select as 20261029120000_driver_privacy_views.sql; create or replace allows a column added last.
create or replace view public.circuit_layouts_shown with (security_invoker = false, security_barrier = true) as
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
  c.pit_exit_y,
  c.category
from public.circuit_layouts c;

comment on view public.circuit_layouts_shown is
  'circuit_layouts for pages (U4): a lap record holder equal to a hidden driver''s full name reads "Hidden Driver".';

-- 4. Read-only for everyone, as before: restated so the grants are exact whatever the replace kept.
revoke all on table public.circuit_layouts_shown from public, anon, authenticated, service_role;
grant select on table public.circuit_layouts_shown to anon, authenticated, service_role;
