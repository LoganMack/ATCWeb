-- Each event session (practice/qualifying/race1-3) can now also store its
-- in-sim start time — the simulated time-of-day iRacing is set to for that
-- session (affects lighting/weather progression), which is a separate
-- concept from the session's real-world/local start_time columns already
-- on this table (when people actually need to show up). Nullable and
-- independent per session, same optionality as the existing *_start_time
-- columns for qualifying/race2/race3.
alter table events
  add column if not exists practice_sim_time time,
  add column if not exists qualifying_sim_time time,
  add column if not exists race1_sim_time time,
  add column if not exists race2_sim_time time,
  add column if not exists race3_sim_time time;
