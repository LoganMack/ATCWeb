-- Alpha Touring Challenge — optional plate behind a circuit's primary logo
--
-- Some track logos are too dark for the site's dark theme or too light for the
-- light theme. Each circuit can now carry an admin-chosen background for its
-- logo: 'light' (white plate), 'dark' (near-black plate), or null (no plate).
-- Editable on /admin/circuits/<id>; read by getCircuitLogoBackgrounds().

alter table circuits add column if not exists logo_background text;

alter table circuits drop constraint if exists circuits_logo_background_check;
alter table circuits add constraint circuits_logo_background_check check (logo_background is null or logo_background in ('light', 'dark'));
