-- Ties events (schedule-side: circuit, times, weather — admin-authored
-- ahead of the race) to curated_rounds (results-side: raw finishes, scored
-- via race_scores — populated either by the real iRacing pipeline with a
-- positive subsession_id, or by the existing manual CSV importer
-- (src/lib/raceResultsImport.ts) with a synthetic negative one). Per Logan:
-- scheduling an event should let you mark which season/round it is right
-- away, so results can be uploaded against that round later and the site
-- can show which season/round a past or upcoming event represents.
--
-- Deliberately NOT a hard FK requiring the round to already exist at
-- schedule time — a future event has no subsession_id yet (real ones only
-- exist once iRacing has run the race; synthetic ones only exist once an
-- admin runs the manual importer). Instead:
--   - season_id + round_number identify WHICH round this event represents,
--     independent of whether a curated_rounds row for it exists yet. Once
--     one shows up (real or manually imported) with a matching season_id +
--     round_number, the app resolves the two together live — see
--     getEventRound() in src/lib/results.ts — with no write-back step and
--     no risk of the two going stale relative to each other.
--   - subsession_id is a nullable, admin-settable MANUAL override/pin for
--     when season_id + round_number auto-matching isn't the right tool —
--     namely TEST/EXHIBITION events (season-agnostic by design, so they
--     have no round_number to match on) that got a real round via the
--     manual importer and need to be pointed at it directly.
--
-- category replaces the implicit "every event is a championship event"
-- assumption with three explicit kinds: the existing default behavior
-- (championship — expects season_id/round_number), plus two new
-- season-agnostic kinds for the parts of the calendar that were always
-- being handled as one-offs anyway — TEST (private/practice sessions,
-- grey) and EXHIBITION (fun/non-points races, gradient) — mirroring the
-- round-level exhibition concept (round_overrides.is_exhibition /
-- non-championship season naming, see results.ts's isChampionshipSeason)
-- but at the EVENT level, which didn't have an equivalent distinction
-- before this.
alter table public.events
  add column category text not null default 'championship'
    check (category in ('championship', 'test', 'exhibition')),
  add column season_id uuid references public.seasons(id),
  add column round_number integer,
  add column subsession_id bigint references public.curated_rounds(subsession_id),
  add constraint events_season_round_paired
    check ((season_id is null) = (round_number is null));

comment on column public.events.category is
  'championship (default, expects season_id/round_number) | test (grey, season-agnostic) | exhibition (gradient, season-agnostic).';
comment on column public.events.season_id is
  'Which season this event''s round belongs to, if any — paired with round_number (both null or both set). Auto-matched against curated_rounds live, not a stored link — see getEventRound() in results.ts.';
comment on column public.events.round_number is
  'Round ordinal within season_id (curated_rounds.round_number''s own numbering) — set at scheduling time, before any curated_rounds row for it may even exist yet.';
comment on column public.events.subsession_id is
  'Manual override/pin to a specific curated_rounds row, for when season_id+round_number auto-matching isn''t applicable (season-agnostic TEST/EXHIBITION events) or isn''t precise enough. Prefer season_id+round_number auto-matching when it applies.';

create index if not exists events_season_round_idx on public.events (season_id, round_number) where season_id is not null;
