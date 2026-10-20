-- Adds an explicit session_type flag to penalties so an incident can be
-- logged against Qualifying or Practice, not just a numbered race.
--
-- race_number stays NOT NULL (no change to that constraint) — a
-- qualifying/practice penalty stores race_number = 0, a sentinel value that
-- can never collide with a real race (curated_race_results.race_number is
-- always 1-5). Everything that recalculates race results/positions
-- (applyPenaltiesToRoundResults in src/lib/penalties.ts) only ever looks up
-- race_number keys that actually exist in a round's real RoundResults, so a
-- race_number = 0 entry is naturally never visited/applied — quali/practice
-- incidents are informational-only by construction, not by extra filtering.
--
-- Mirrors round_overrides.is_exhibition/is_test being independent explicit
-- columns rather than one merged "category" field (see
-- 0036_round_test_flag.sql's own comment) — same reasoning applied here:
-- add a new explicit flag rather than overload race_number's meaning.
alter table public.penalties
  add column session_type text not null default 'race'
  check (session_type in ('race', 'qualifying', 'practice'));
