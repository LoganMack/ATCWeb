-- Alpha Touring Challenge — champions, standings & results
--
-- IMPORTANT CONTEXT: the results/scoring pipeline tables this migration
-- grants read access to (curated_rounds, curated_race_results,
-- curated_qualifying, race_scores, and the columns added to `seasons` for
-- drop weeks / scoring rulesets) are created and populated by a separate,
-- external iRacing-results import pipeline — NOT by this repo. Nothing
-- below creates or alters those tables' shape. This migration only:
--   1. Enables RLS + adds a public-read policy for the ones the site's new
--      history pages need to query with the anon key, the same way every
--      other public page reads data. They likely have no RLS configured
--      yet since the import pipeline writes with a service-role key, which
--      bypasses RLS regardless — enabling it here is additive/safe and
--      changes nothing about how that pipeline writes.
--   2. Adds `champion_photos`, which IS owned by this repo — the up-to-3
--      uploaded photos shown on the public Champions page for each
--      season+class champion.
--
-- ---------------------------------------------------------------------------
-- Public read access for the results pipeline's tables
-- ---------------------------------------------------------------------------

alter table curated_rounds enable row level security;
alter table curated_race_results enable row level security;
alter table curated_qualifying enable row level security;
alter table race_scores enable row level security;

-- `drop policy if exists` first makes this safe to re-run even if a policy
-- with this name already exists (Postgres has no `create policy if not
-- exists`).
drop policy if exists "public read" on curated_rounds;
create policy "public read" on curated_rounds for select using (true);

drop policy if exists "public read" on curated_race_results;
create policy "public read" on curated_race_results for select using (true);

drop policy if exists "public read" on curated_qualifying;
create policy "public read" on curated_qualifying for select using (true);

drop policy if exists "public read" on race_scores;
create policy "public read" on race_scores for select using (true);

-- ---------------------------------------------------------------------------
-- champion_photos
--
-- Up to 3 photos per (season, class) champion slot, shown on the public
-- /champions page. `driver_id` is stored for the admin UI's own reference
-- (so it's obvious at a glance whose photos these are) but the public page
-- looks these up purely by (season_id, class_id) — it does NOT require
-- driver_id to match whatever the standings computation currently returns
-- as the champion. That's a deliberate simplification: if a scoring
-- correction ever changed who a season's champion was, previously uploaded
-- photos would just keep showing under that season/class slot rather than
-- silently disappearing; re-uploading under the (now-correct) champion is a
-- manual admin fix, not something worth adding cross-check logic for on a
-- small-league site.
-- ---------------------------------------------------------------------------

create table champion_photos (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references seasons(id) on delete cascade,
  class_id int not null references driver_classes(id),
  driver_id uuid not null references drivers(id) on delete cascade,
  image_url text not null,
  sort_order int not null default 0 check (sort_order >= 0 and sort_order < 3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint champion_photos_unique_slot unique (season_id, class_id, sort_order)
);

create index champion_photos_lookup_idx on champion_photos (season_id, class_id);

create trigger champion_photos_set_updated_at before update on champion_photos
  for each row execute function set_updated_at();

alter table champion_photos enable row level security;

create policy "public read" on champion_photos for select using (true);
create policy "admin write champion_photos" on champion_photos for insert with check (is_admin());
create policy "admin update champion_photos" on champion_photos for update using (is_admin());
create policy "admin delete champion_photos" on champion_photos for delete using (is_admin());
