-- "Test" events are being renamed to "Test Session" in the UI and no longer
-- require a Race 1 time to be saved (no format shown/used either — that's
-- display-logic only, no schema change needed for it). race1_start_time was
-- the one column on `events` assumed always-present; relaxing it here is
-- the only DB change this needs.
alter table public.events alter column race1_start_time drop not null;
