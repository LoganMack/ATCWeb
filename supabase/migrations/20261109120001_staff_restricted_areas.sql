-- Staff restricted areas (broadcaster-staff-roles; rules BR2.4-BR2.6).
--
-- What: Staff keep panel access everywhere (private.is_admin() is Admin or Staff since
-- 20261109120000_staff_role_and_broadcaster.sql), except five areas only a full Admin may change:
-- Site Properties, Seasons, Rulesets, Media and Circuits. Their tables' insert, update and delete
-- policies move to public.is_full_admin():
--   page_banners, car_logos, penalty_offenses, champion_photos, hall_of_fame_photos, seasons,
--   scoring_rulesets, media_videos, media_graphics, media_meetups, media_meetup_drivers, circuits,
--   circuit_layouts, layout_corners, layout_incident_pins, track_guides.
-- site_settings writes need a full Admin, except the four driver-status keys on Admin > Drivers, which
-- panel access may still change. In storage, the banners bucket is full Admin; in logos, objects named
-- circuit-*, season-* or car-* are full Admin; in photos, media-*, hall-of-fame-* and champion-* are.
-- Team logos, driver photos, news covers and a driver's own avatar folder stay as they were.
--
-- Why in the database: Staff could otherwise write these through a direct API call; the pages only hide
-- the tools. Reads are unchanged, and definer functions that write these as part of an allowed job (such
-- as rescoring) keep working because they don't go through these policies.
--
-- Expand only: Admins pass every new check, and nobody is Staff until an Admin says so, so the code on
-- main is unaffected. Undo with supabase/down/20261109120001_staff_restricted_areas.down.sql.
-- supabase/checks/staff-broadcaster-fixtures.sql fails if any policy here still accepts panel access.

-- 1. The restricted areas' tables (BR2.4) ---------------------------------------------------------------
alter policy "admin write page_banners" on public.page_banners with check (public.is_full_admin());
alter policy "admin update page_banners" on public.page_banners using (public.is_full_admin());
alter policy "admin delete page_banners" on public.page_banners using (public.is_full_admin());

alter policy "admin write car_logos" on public.car_logos with check (public.is_full_admin());
alter policy "admin update car_logos" on public.car_logos using (public.is_full_admin());
alter policy "admin delete car_logos" on public.car_logos using (public.is_full_admin());

alter policy "admin write penalty_offenses" on public.penalty_offenses with check (public.is_full_admin());
alter policy "admin update penalty_offenses" on public.penalty_offenses using (public.is_full_admin());
alter policy "admin delete penalty_offenses" on public.penalty_offenses using (public.is_full_admin());

alter policy "admin write champion_photos" on public.champion_photos with check (public.is_full_admin());
alter policy "admin update champion_photos" on public.champion_photos using (public.is_full_admin());
alter policy "admin delete champion_photos" on public.champion_photos using (public.is_full_admin());

alter policy "admin write hall_of_fame_photos" on public.hall_of_fame_photos with check (public.is_full_admin());
alter policy "admin update hall_of_fame_photos" on public.hall_of_fame_photos using (public.is_full_admin());
alter policy "admin delete hall_of_fame_photos" on public.hall_of_fame_photos using (public.is_full_admin());

-- Seasons have no insert or delete policy: they are only ever updated through the API.
alter policy "admin update seasons" on public.seasons using (public.is_full_admin());

alter policy "admin insert rulesets" on public.scoring_rulesets with check (public.is_full_admin());
alter policy "admin update rulesets" on public.scoring_rulesets using (public.is_full_admin());
alter policy "admin delete rulesets" on public.scoring_rulesets using (public.is_full_admin());

alter policy "admin write media_videos" on public.media_videos with check (public.is_full_admin());
alter policy "admin update media_videos" on public.media_videos using (public.is_full_admin());
alter policy "admin delete media_videos" on public.media_videos using (public.is_full_admin());

alter policy "admin write media_graphics" on public.media_graphics with check (public.is_full_admin());
alter policy "admin update media_graphics" on public.media_graphics using (public.is_full_admin());
alter policy "admin delete media_graphics" on public.media_graphics using (public.is_full_admin());

alter policy "admin write media_meetups" on public.media_meetups with check (public.is_full_admin());
alter policy "admin update media_meetups" on public.media_meetups using (public.is_full_admin());
alter policy "admin delete media_meetups" on public.media_meetups using (public.is_full_admin());

-- Meetup drivers are replaced, never updated, so there is no update policy.
alter policy "admin write media_meetup_drivers" on public.media_meetup_drivers with check (public.is_full_admin());
alter policy "admin delete media_meetup_drivers" on public.media_meetup_drivers using (public.is_full_admin());

alter policy "admin write circuits" on public.circuits with check (public.is_full_admin());
alter policy "admin update circuits" on public.circuits using (public.is_full_admin());
alter policy "admin delete circuits" on public.circuits using (public.is_full_admin());

alter policy "admin write circuit_layouts" on public.circuit_layouts with check (public.is_full_admin());
alter policy "admin update circuit_layouts" on public.circuit_layouts using (public.is_full_admin());
alter policy "admin delete circuit_layouts" on public.circuit_layouts using (public.is_full_admin());

alter policy "admin insert layout_corners" on public.layout_corners with check (public.is_full_admin());
alter policy "admin update layout_corners" on public.layout_corners using (public.is_full_admin());
alter policy "admin delete layout_corners" on public.layout_corners using (public.is_full_admin());

alter policy "admin insert layout_incident_pins" on public.layout_incident_pins with check (public.is_full_admin());
alter policy "admin update layout_incident_pins" on public.layout_incident_pins using (public.is_full_admin());
alter policy "admin delete layout_incident_pins" on public.layout_incident_pins using (public.is_full_admin());

alter policy "admin write track_guides" on public.track_guides with check (public.is_full_admin());
alter policy "admin update track_guides" on public.track_guides using (public.is_full_admin());
alter policy "admin delete track_guides" on public.track_guides using (public.is_full_admin());

-- 2. Site settings: full Admin, or panel access for the four driver-status keys (BR2.5) ------------------
alter policy "admin write site_settings" on public.site_settings
  with check (public.is_full_admin()
              or (public.is_admin()
                  and setting_key = any (array['probation_days', 'probation_rounds', 'inactivity_days', 'inactivity_rounds'])));
alter policy "admin update site_settings" on public.site_settings
  using (public.is_full_admin()
         or (public.is_admin()
             and setting_key = any (array['probation_days', 'probation_rounds', 'inactivity_days', 'inactivity_rounds'])));
alter policy "admin delete site_settings" on public.site_settings
  using (public.is_full_admin()
         or (public.is_admin()
             and setting_key = any (array['probation_days', 'probation_rounds', 'inactivity_days', 'inactivity_rounds'])));

-- 3. Stored files of the restricted areas (BR2.6) -----------------------------------------------------
alter policy "admin write banners" on storage.objects
  with check (bucket_id = 'banners' and public.is_full_admin());
alter policy "admin update banners" on storage.objects
  using (bucket_id = 'banners' and public.is_full_admin());
alter policy "admin delete banners" on storage.objects
  using (bucket_id = 'banners' and public.is_full_admin());

alter policy "admin write logos" on storage.objects
  with check (bucket_id = 'logos' and public.is_admin()
              and (public.is_full_admin() or name !~ '^(circuit-|season-|car-)'));
alter policy "admin update logos" on storage.objects
  using (bucket_id = 'logos' and public.is_admin()
         and (public.is_full_admin() or name !~ '^(circuit-|season-|car-)'));
alter policy "admin delete logos" on storage.objects
  using (bucket_id = 'logos' and public.is_admin()
         and (public.is_full_admin() or name !~ '^(circuit-|season-|car-)'));

alter policy "admin write photos" on storage.objects
  with check (bucket_id = 'photos' and public.is_admin()
              and (public.is_full_admin() or name !~ '^(media-|hall-of-fame-|champion-)'));
alter policy "admin update photos" on storage.objects
  using (bucket_id = 'photos' and public.is_admin()
         and (public.is_full_admin() or name !~ '^(media-|hall-of-fame-|champion-)'));
alter policy "admin delete photos" on storage.objects
  using (bucket_id = 'photos' and public.is_admin()
         and (public.is_full_admin() or name !~ '^(media-|hall-of-fame-|champion-)'));
