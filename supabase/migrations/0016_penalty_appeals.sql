-- Alpha Touring Challenge — penalty appeals
--
-- Lets a steward mark a logged penalty as appealed and record the outcome:
-- a free-text ruling (appeal_result) plus the corrected time/points/PP
-- values the appeal actually landed on. When is_appealed is true, the
-- app's recalculation engine (src/lib/penalties.ts) uses these appeal_*
-- values instead of the original time_penalty_seconds/points_penalty/
-- penalty_points everywhere it matters (this race's results, the driver's
-- season points/PP tallies) — the original fields are left untouched as a
-- record of what was first logged.
--
-- Same blank-means-"none" convention as the original fields:
-- appeal_time_penalty_seconds is nullable (blank = no time penalty),
-- appeal_points_penalty/appeal_penalty_points default to 0 (blank = none).

alter table penalties add column if not exists is_appealed boolean not null default false;
alter table penalties add column if not exists appeal_result text;
alter table penalties add column if not exists appeal_time_penalty_seconds numeric;
alter table penalties add column if not exists appeal_points_penalty integer not null default 0;
alter table penalties add column if not exists appeal_penalty_points integer not null default 0;
