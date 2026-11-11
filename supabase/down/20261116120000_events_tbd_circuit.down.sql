-- Undoes 20261116120000_events_tbd_circuit.sql: restores the stricter events_circuit_or_title_check (every
-- category except HOLIDAY/IRACING needs a circuit) and the original column comment.
--
-- Fails while any To Be Determined event exists (a championship, exhibition or test event with no circuit).
-- Give those events a circuit, or delete them, first. Revert the site code first too, so nothing saves a new
-- one in between.

alter table public.events drop constraint events_circuit_or_title_check;

alter table public.events add constraint events_circuit_or_title_check check (
  (category = any (array['holiday'::text, 'iracing'::text]) and circuit_id is null and title is not null)
  or (category <> all (array['holiday'::text, 'iracing'::text]) and circuit_id is not null)
);

comment on column public.events.circuit_id is
  'Nullable since 0073_holiday_iracing_events.sql — every category except HOLIDAY/IRACING still requires one (events_circuit_or_title_check).';
