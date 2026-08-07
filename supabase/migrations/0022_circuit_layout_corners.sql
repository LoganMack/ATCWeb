-- Each circuit layout's own corner count, admin-entered per layout (same
-- pattern as length_km) — needed to compute a driver's season "corners per
-- incident" stat on the Standings page (see src/lib/results.ts's
-- getSeasonDriverExtendedStats), which laps/length_km alone can't derive.
-- Nullable: existing layouts have no value until Logan fills them in via
-- Admin -> Circuits, and the stat that depends on it degrades gracefully
-- (omitted, not faked) for any round whose layout has no corner count set.
alter table circuit_layouts
  add column if not exists corners integer;
