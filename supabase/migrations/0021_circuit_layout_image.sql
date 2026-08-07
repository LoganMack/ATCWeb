-- Each circuit layout (e.g. a track's short/long/oval configuration) gets
-- its own image instead of every layout sharing the single image stored on
-- the parent circuits row. circuits.logo_url remains as the fallback shown
-- when a specific layout has no image of its own on file.
alter table circuit_layouts
  add column if not exists image_url text;
