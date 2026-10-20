-- Alpha Touring Challenge — backfill Admin -> Events from existing rounds
--
-- Per Logan: the Events admin panel (schema since 0035_events_rounds_
-- categories.sql, its own admin UI predating this migration) has mostly
-- only ever been populated going forward from whenever an admin actually
-- used it or the schedule-CSV importer (admin/import) — every round that
-- was already raced and sitting in curated_rounds before that never got a
-- matching `events` row. This is a one-time data migration, not a schema
-- change: one `events` row per curated_rounds row that doesn't already
-- resolve to one, so the whole historical calendar shows up in Admin ->
-- Events (and can have this migration's new race*_wet_affected flag, or
-- anything else, filled in after the fact).
--
-- What gets deduced, and how (Logan: "any other information you can
-- deduce, use it"):
--   - circuit_id: exact match of curated_rounds.track_name to circuits.name,
--     normalized the same case/punctuation/whitespace-insensitive way this
--     repo already matches the two everywhere else (results.ts's
--     resolveLayout / newsRecap.ts's matchCircuitLayout) — NOT fuzzy. A
--     round whose track has no circuits row on file at all is skipped
--     (circuit_id is NOT NULL on events) rather than guessed at; it'll log
--     a NOTICE below so Logan knows which ones to add manually.
--   - layout: copied straight from curated_rounds.layout (0018_curated_
--     rounds_layout.sql) — same free-text column on both tables.
--   - event_date: curated_rounds.start_time's calendar date in the league's
--     own timezone (America/New_York — see src/lib/timezone.ts), not UTC,
--     since that's what an admin would have typed into this same field by
--     hand.
--   - format: curated_rounds.format, defaulting to 'sprint' (events.format's
--     own default) on the rare round where the pipeline never set one.
--   - category/season_id/round_number/subsession_id: 'championship' with
--     season_id+round_number copied straight across (the same auto-match
--     pair getEventRound() in results.ts already uses) when the round
--     belongs to a real championship season (isChampionshipSeason — an
--     "ATCxx"-named season) AND isn't flagged an exhibition itself
--     (round_overrides.is_exhibition) AND has a round_number to match on;
--     otherwise 'exhibition' with season_id/round_number left null and
--     subsession_id pinned directly — exactly the "TEST/EXHIBITION events
--     ... need to be pointed at it directly" case 0035's own header
--     describes, and the same category a human admin would have picked by
--     hand for the same round.
--   - Every session-time/sim-time/minutes/laps/weather field, and
--     fuel_limit_pct/results_url: left null. None of that is recoverable
--     from curated_rounds (which only has race RESULTS, not the schedule an
--     admin would have entered ahead of time) — Weather in particular is
--     explicitly the one thing Logan said this migration can't figure out.
--     race1_start_time is nullable since 0054_test_session_no_race_
--     required.sql, so this doesn't violate anything at the DB level; the
--     app's own save-form will just ask for it if that event is ever
--     re-saved through Admin -> Events.
--
-- Skips (never overwrites, never duplicates) a round that already resolves
-- to an events row by EITHER of the two matching rules above, OR shares an
-- existing event's (circuit_id, event_date) pair — the same dedup key
-- admin/import's own schedule-CSV importer already uses for "is this
-- already on the calendar," in case Logan hand-entered some of these
-- historical weekends before this migration ran. Safe to re-run: every
-- round it successfully backfills on one run won't match "no existing
-- event" on the next.
do $$
declare
  r record;
  v_circuit_id uuid;
  v_is_exhibition_round boolean;
  v_is_championship_season boolean;
  v_category text;
  v_season_id uuid;
  v_round_number integer;
  v_subsession_pin bigint;
  v_event_date date;
  v_inserted int := 0;
  v_skipped_no_circuit int := 0;
  v_skipped_existing int := 0;
begin
  for r in
    select cr.subsession_id, cr.season_id, cr.round_number, cr.start_time,
           cr.track_name, cr.layout, cr.format, s.name as season_name
    from public.curated_rounds cr
    left join public.seasons s on s.id = cr.season_id
    order by cr.start_time asc
  loop
    select c.id into v_circuit_id
    from public.circuits c
    where regexp_replace(lower(c.name), '[^a-z0-9]', '', 'g')
        = regexp_replace(lower(r.track_name), '[^a-z0-9]', '', 'g')
    limit 1;

    if v_circuit_id is null then
      v_skipped_no_circuit := v_skipped_no_circuit + 1;
      raise notice 'Skipped subsession % (%): no circuit in Admin -> Circuits matches this track name.', r.subsession_id, r.track_name;
      continue;
    end if;

    v_event_date := (r.start_time at time zone 'America/New_York')::date;

    v_is_exhibition_round := exists (
      select 1 from public.round_overrides ro
      where ro.subsession_id = r.subsession_id and ro.is_exhibition
    );
    v_is_championship_season := r.season_name is not null and trim(r.season_name) ~* '^ATC[0-9]+$';

    if r.season_id is not null and r.round_number is not null
       and v_is_championship_season and not v_is_exhibition_round then
      v_category := 'championship';
      v_season_id := r.season_id;
      v_round_number := r.round_number;
      v_subsession_pin := null;
    else
      v_category := 'exhibition';
      v_season_id := null;
      v_round_number := null;
      v_subsession_pin := r.subsession_id;
    end if;

    if exists (
      select 1 from public.events e
      where (v_season_id is not null and e.season_id = v_season_id and e.round_number = v_round_number)
         or (v_subsession_pin is not null and e.subsession_id = v_subsession_pin)
         or (e.circuit_id = v_circuit_id and e.event_date = v_event_date)
    ) then
      v_skipped_existing := v_skipped_existing + 1;
      continue;
    end if;

    insert into public.events (
      circuit_id, layout, event_date, format, category, season_id, round_number, subsession_id
    ) values (
      v_circuit_id, r.layout, v_event_date, coalesce(r.format, 'sprint'), v_category, v_season_id, v_round_number, v_subsession_pin
    );
    v_inserted := v_inserted + 1;
  end loop;

  raise notice 'Backfilled % event(s) from curated_rounds; % skipped (no matching circuit); % skipped (already on the calendar).',
    v_inserted, v_skipped_no_circuit, v_skipped_existing;
end $$;
