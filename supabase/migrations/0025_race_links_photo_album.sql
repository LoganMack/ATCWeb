-- Alpha Touring Challenge — a photo album link per race
--
-- A fourth optional per-race external link on race_links (see
-- 0007_race_links.sql for iracing_subsession_id/replay_url/broadcast_url,
-- and 0014_penalties.sql for incident_report_url) — wherever the series
-- photographer's album for that specific race lives (e.g. a Flickr album).
-- Same column shape/nullability as its siblings.

alter table race_links add column if not exists photo_album_url text;
