-- Undoes 20261109120001_staff_restricted_areas.sql: every policy it changed goes back to panel access
-- (public.is_admin()), exactly as the baseline defines it. Nothing else changes; no data is touched.

alter policy "admin write page_banners" on public.page_banners with check (public.is_admin());
alter policy "admin update page_banners" on public.page_banners using (public.is_admin());
alter policy "admin delete page_banners" on public.page_banners using (public.is_admin());

alter policy "admin write car_logos" on public.car_logos with check (public.is_admin());
alter policy "admin update car_logos" on public.car_logos using (public.is_admin());
alter policy "admin delete car_logos" on public.car_logos using (public.is_admin());

alter policy "admin write penalty_offenses" on public.penalty_offenses with check (public.is_admin());
alter policy "admin update penalty_offenses" on public.penalty_offenses using (public.is_admin());
alter policy "admin delete penalty_offenses" on public.penalty_offenses using (public.is_admin());

alter policy "admin write champion_photos" on public.champion_photos with check (public.is_admin());
alter policy "admin update champion_photos" on public.champion_photos using (public.is_admin());
alter policy "admin delete champion_photos" on public.champion_photos using (public.is_admin());

alter policy "admin write hall_of_fame_photos" on public.hall_of_fame_photos with check (public.is_admin());
alter policy "admin update hall_of_fame_photos" on public.hall_of_fame_photos using (public.is_admin());
alter policy "admin delete hall_of_fame_photos" on public.hall_of_fame_photos using (public.is_admin());

alter policy "admin update seasons" on public.seasons using (public.is_admin());

alter policy "admin insert rulesets" on public.scoring_rulesets with check (public.is_admin());
alter policy "admin update rulesets" on public.scoring_rulesets using (public.is_admin());
alter policy "admin delete rulesets" on public.scoring_rulesets using (public.is_admin());

alter policy "admin write media_videos" on public.media_videos with check (public.is_admin());
alter policy "admin update media_videos" on public.media_videos using (public.is_admin());
alter policy "admin delete media_videos" on public.media_videos using (public.is_admin());

alter policy "admin write media_graphics" on public.media_graphics with check (public.is_admin());
alter policy "admin update media_graphics" on public.media_graphics using (public.is_admin());
alter policy "admin delete media_graphics" on public.media_graphics using (public.is_admin());

alter policy "admin write media_meetups" on public.media_meetups with check (public.is_admin());
alter policy "admin update media_meetups" on public.media_meetups using (public.is_admin());
alter policy "admin delete media_meetups" on public.media_meetups using (public.is_admin());

alter policy "admin write media_meetup_drivers" on public.media_meetup_drivers with check (public.is_admin());
alter policy "admin delete media_meetup_drivers" on public.media_meetup_drivers using (public.is_admin());

alter policy "admin write circuits" on public.circuits with check (public.is_admin());
alter policy "admin update circuits" on public.circuits using (public.is_admin());
alter policy "admin delete circuits" on public.circuits using (public.is_admin());

alter policy "admin write circuit_layouts" on public.circuit_layouts with check (public.is_admin());
alter policy "admin update circuit_layouts" on public.circuit_layouts using (public.is_admin());
alter policy "admin delete circuit_layouts" on public.circuit_layouts using (public.is_admin());

alter policy "admin insert layout_corners" on public.layout_corners with check (public.is_admin());
alter policy "admin update layout_corners" on public.layout_corners using (public.is_admin());
alter policy "admin delete layout_corners" on public.layout_corners using (public.is_admin());

alter policy "admin insert layout_incident_pins" on public.layout_incident_pins with check (public.is_admin());
alter policy "admin update layout_incident_pins" on public.layout_incident_pins using (public.is_admin());
alter policy "admin delete layout_incident_pins" on public.layout_incident_pins using (public.is_admin());

alter policy "admin write track_guides" on public.track_guides with check (public.is_admin());
alter policy "admin update track_guides" on public.track_guides using (public.is_admin());
alter policy "admin delete track_guides" on public.track_guides using (public.is_admin());

alter policy "admin write site_settings" on public.site_settings with check (public.is_admin());
alter policy "admin update site_settings" on public.site_settings using (public.is_admin());
alter policy "admin delete site_settings" on public.site_settings using (public.is_admin());

-- supabase/migrations/20261020120001_baseline_platform.sql's storage policies.
alter policy "admin write banners" on storage.objects with check (bucket_id = 'banners'::text and public.is_admin());
alter policy "admin update banners" on storage.objects using (bucket_id = 'banners'::text and public.is_admin());
alter policy "admin delete banners" on storage.objects using (bucket_id = 'banners'::text and public.is_admin());

alter policy "admin write logos" on storage.objects with check (bucket_id = 'logos'::text and public.is_admin());
alter policy "admin update logos" on storage.objects using (bucket_id = 'logos'::text and public.is_admin());
alter policy "admin delete logos" on storage.objects using (bucket_id = 'logos'::text and public.is_admin());

alter policy "admin write photos" on storage.objects with check (bucket_id = 'photos'::text and public.is_admin());
alter policy "admin update photos" on storage.objects using (bucket_id = 'photos'::text and public.is_admin());
alter policy "admin delete photos" on storage.objects using (bucket_id = 'photos'::text and public.is_admin());
