-- Adds two new season-agnostic, circuit-less event categories: HOLIDAY and
-- IRACING. Per Logan: these mark calendar entries that aren't a race
-- weekend at all (a holiday break, an iRacing-side announcement/update) —
-- no track, no sessions, no format. They show a Title (and optional
-- Subtitle) in place of the circuit name/layout, get no logo (there's no
-- circuit_id to look one up from), and are deliberately excluded from the
-- homepage's "Upcoming Events" widget (see getUpcomingEvents() in
-- src/lib/supabase.ts) since that widget is meant to tease the next actual
-- race, not a day off. They still appear normally on the full /calendar
-- page's List/Calendar views, same as every other category.
--
-- circuit_id was NOT NULL from day one (0003_calendar.sql) — every event
-- used to be, by definition, a race at some circuit. That assumption no
-- longer holds for these two categories, so it's relaxed to nullable and
-- paired with a CHECK making the requirement symmetric: every OTHER
-- category still needs a real circuit_id, while HOLIDAY/IRACING need a
-- title instead (and must NOT have a circuit_id — no dangling half-set
-- state where a Holiday event quietly points at some circuit no UI ever
-- shows).

alter table public.events
  alter column circuit_id drop not null,
  add column title text,
  add column subtitle text;

comment on column public.events.circuit_id is
  'Nullable since 0073_holiday_iracing_events.sql — every category except HOLIDAY/IRACING still requires one (events_circuit_or_title_check).';
comment on column public.events.title is
  'Display title for a HOLIDAY/IRACING event, shown in place of the circuit name — required for those two categories, null for every other one (which use circuit_id + circuits.name instead). See events_circuit_or_title_check.';
comment on column public.events.subtitle is
  'Optional subtitle for a HOLIDAY/IRACING event, shown in place of the layout name. Null otherwise.';

-- Widen the category CHECK constraint to allow the two new values. Found
-- and dropped dynamically rather than by a guessed/hardcoded name, since
-- 0035_events_rounds_categories.sql added it inline (`add column category
-- text ... check (...)`) without naming it explicitly.
--
-- Note: the loop variable below is deliberately NOT named the same as the
-- table alias used in its query (a classic PL/pgSQL gotcha — when they
-- collide, "loopvar.field" in the SELECT list resolves against the
-- not-yet-assigned record variable itself rather than the query's alias,
-- raising "record is not assigned yet").
do $$
declare
  rec record;
begin
  for rec in
    select c.conname
    from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_attribute att
      on att.attrelid = c.conrelid
     and att.attnum = any(c.conkey)
    where rel.relname = 'events'
      and c.contype = 'c'
      and att.attname = 'category'
  loop
    execute format('alter table public.events drop constraint %I', rec.conname);
  end loop;
end $$;

alter table public.events
  add constraint events_category_check
  check (category in ('championship', 'test', 'exhibition', 'holiday', 'iracing'));

comment on column public.events.category is
  'championship (default, expects season_id/round_number) | test (grey, season-agnostic) | exhibition (gradient, season-agnostic) | holiday (gold, season-agnostic + circuit-less) | iracing (blue, season-agnostic + circuit-less).';

-- Symmetric with events_season_round_paired: HOLIDAY/IRACING must have a
-- title and no circuit_id; every other category must have a circuit_id
-- (title is allowed to be null for them — nothing reads it in that case).
alter table public.events
  add constraint events_circuit_or_title_check
  check (
    (category in ('holiday', 'iracing') and circuit_id is null and title is not null)
    or
    (category not in ('holiday', 'iracing') and circuit_id is not null)
  );
