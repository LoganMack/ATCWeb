-- Alpha Touring Challenge — circuit location
--
-- Powers the new public Circuits tab (Logan: "a list of every circuit,
-- with their image, name, and location"). Free text (e.g. "Le Mans,
-- France") rather than separate city/country/lat-long columns — nothing
-- else in the app needs to query or filter on it structurally, it's just
-- displayed.
alter table circuits add column if not exists location text;
