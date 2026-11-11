-- Lets a championship, exhibition or test event be saved with no circuit, so admins can put an event on the
-- calendar before the venue is known ("To Be Determined"). Holiday and iRacing events keep their rule: no
-- circuit and a title.
--
-- Expand only: the check gets looser, so every existing row still passes and the code on main, which never
-- saves such an event, keeps working. The site's event form is the only place that offers TBD and clears the
-- circuit-dependent fields itself.

alter table public.events drop constraint events_circuit_or_title_check;

alter table public.events add constraint events_circuit_or_title_check check (
  (category = any (array['holiday'::text, 'iracing'::text]) and circuit_id is null and title is not null)
  or (category <> all (array['holiday'::text, 'iracing'::text]))
);

comment on column public.events.circuit_id is
  'Null for HOLIDAY/IRACING events (events_circuit_or_title_check), and for any other event whose circuit is still To Be Determined.';
