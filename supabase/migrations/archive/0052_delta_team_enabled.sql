-- Alpha Touring Challenge — seasons.delta_team_enabled
--
-- The Delta driver CLASS and the separate Delta TEAM championship have
-- different histories: the class itself has existed since ATC5
-- (seasons.delta_enabled, 0037_class_and_scoring_fixes.sql), but the
-- standalone Delta Team competition — its own standings/champion, shown
-- alongside "Alpha Team" on /champions and /team-standings — wasn't
-- introduced until ATC10. Until now, anything that computed a Delta Team
-- standing inferred "did this season have one?" purely from whether any
-- Delta-class race_scores rows existed that season, which incorrectly
-- surfaced a Delta Team champion/position for ATC5-ATC9 (real Delta class
-- data, but no such team competition yet). This column makes that an
-- explicit, admin-editable flag instead — same "enable per season" shape
-- as gamma_enabled/delta_enabled, editable from the same /admin/seasons row.
alter table public.seasons
  add column delta_team_enabled boolean not null default false;

comment on column public.seasons.delta_team_enabled is
  'Whether the separate Delta TEAM championship (distinct from the Delta driver class — see delta_enabled) ran this season. The Delta class itself existed from ATC5, but the standalone Delta Team competition/standings only began at ATC10. Controls whether Delta Team standings/champions show for this season on the public site.';

-- Backfill: on for every real championship season from ATC10 onward,
-- matching the season data queried live before writing this migration
-- (delta_enabled — the class flag — was already true continuously from
-- ATC5 through the current season; this is the narrower "team competition
-- also existed" subset of that, starting 5 seasons later). Off for
-- everything else, including the non-championship rows (ATC Exhibitions,
-- ATC4 Off-Season Fun Series, LCC1) that never have real standings anyway.
update public.seasons set delta_team_enabled = true where name ~ '^ATC[0-9]+$' and number >= 10;
