-- Alpha Touring Challenge — curated_rounds.event_id + curated_practice_results
--
-- Two related additions, both prep for the admin dashboard's new "x finished
-- events missing race results" metric and the reworked Import pages:
--
-- 1. A REAL link from a round back to the event it belongs to. Until now,
--    "does this event have a result yet" could only be answered by
--    RE-DERIVING the connection at read time — matching events.season_id +
--    events.round_number against curated_rounds.season_id/round_number (see
--    getEventRound() in src/lib/results.ts), with events.subsession_id as a
--    manual override for the cases that don't fit that pattern. That
--    approach is exactly what caused the several rounds-of-bugs earlier this
--    project fixed (0072-0075: wrong round numbers, dedup collisions,
--    unmatched track names) — it's an inference, not a fact stored anywhere.
--    From here on, src/lib/raceResultsImport.ts sets event_id directly at
--    import time (resolved the same way events.astro's own CSV importer
--    already matches a row to an existing event: circuit_id + event_date),
--    so a round's event is a stored fact for every newly-imported round
--    going forward.
--
--    Backfilled for all 237 existing rows using the exact same
--    season_id+round_number / subsession_id-override logic getEventRound()
--    already uses — verified with a dry-run query before writing this
--    migration that this matching is unambiguous today (no event matches
--    more than one round and vice versa), so a straight UPDATE is safe. The
--    partial unique index below guards against that ever silently becoming
--    untrue again.
--
-- 2. curated_practice_results — there was no table for practice results at
--    all (src/pages/results/[subsessionId].astro even has a comment noting
--    "we will create this table later"). Modeled directly on
--    curated_qualifying (same subsession_id/cust_id/display_name/
--    car_class_name/best_lap_ten_thousandths shape, same RLS shape) plus one
--    new `laps` column — a practice session has no finishing/qualifying
--    position to record, but total laps completed is the one meaningful
--    "how much running did they get" stat a practice session actually has.

alter table public.curated_rounds add column event_id uuid references public.events(id) on delete set null;

create index curated_rounds_event_id_idx on public.curated_rounds (event_id);

-- At most one round per event (and vice versa) — matches reality (an event
-- is one race weekend/subsession) and catches any future matching bug
-- immediately instead of letting two rounds silently claim the same event.
create unique index curated_rounds_event_id_unique_idx on public.curated_rounds (event_id) where event_id is not null;

update public.curated_rounds cr
set event_id = e.id
from public.events e
where cr.event_id is null
  and (
    e.subsession_id = cr.subsession_id
    or (
      e.subsession_id is null
      and e.season_id = cr.season_id
      and e.round_number = cr.round_number
      and e.round_number is not null
    )
  );

create table public.curated_practice_results (
  subsession_id bigint not null,
  cust_id bigint not null,
  display_name text not null,
  car_class_name text,
  best_lap_ten_thousandths bigint,
  laps integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index curated_practice_results_subsession_id_idx on public.curated_practice_results (subsession_id);

alter table public.curated_practice_results enable row level security;

-- Same shape as curated_qualifying's own RLS (public read, admin write) —
-- see that table's policies for precedent.
create policy "public read" on public.curated_practice_results for select using (true);
create policy "admin insert practice results" on public.curated_practice_results for insert with check (is_admin());
create policy "admin update practice results" on public.curated_practice_results for update using (is_admin());
create policy "admin delete practice results" on public.curated_practice_results for delete using (is_admin());

-- Backs the admin dashboard's "Add Race Result" card subtitle. A
-- championship event counts as "missing" only once it's actually in the
-- past AND has no curated_rounds row (linked via the new event_id above)
-- with at least one curated_race_results row under it — a round that only
-- has qualifying/practice imported so far still counts as missing its race
-- result. No admin gating needed: events/curated_rounds/curated_race_results
-- are all already public-read tables (this exposes only a count, no rows).
create or replace function public.get_missing_race_results_count()
returns integer
language sql
stable
as $$
  select count(*)::int from public.events e
  where e.category = 'championship'
    and e.event_date < current_date
    and not exists (
      select 1 from public.curated_rounds cr
      join public.curated_race_results crr on crr.subsession_id = cr.subsession_id
      where cr.event_id = e.id
    );
$$;
