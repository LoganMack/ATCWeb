-- Alpha Touring Challenge — remove the manual "Featured Broadcast" site setting
--
-- The homepage's broadcast embed used to be a manually-pasted YouTube URL,
-- set from /admin/site-properties and stored as a 'featured_broadcast_url'
-- row in the generic site_settings key/value table (0026_site_settings.sql).
-- It's now derived automatically (src/lib/results.ts's getAllBroadcastVideos,
-- newest round first) from whatever round's race_links.broadcast_url was
-- most recently set on the round's own results page — so the manual
-- setting, its admin form, and the POST handler that wrote it are all gone
-- from the app. This just cleans up whatever value was last saved there;
-- site_settings itself stays (still used for driver probation/inactivity
-- settings, see src/lib/siteSettings.ts).

delete from public.site_settings where setting_key = 'featured_broadcast_url';
