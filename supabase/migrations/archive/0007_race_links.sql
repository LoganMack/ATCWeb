-- Alpha Touring Challenge — per-race external links
--
-- Three optional links per individual race (not per round — a round with
-- 3 races isn't necessarily 1 iRacing subsession; see the ATC16 Round 1
-- example, where race_number 1's real iRacing subsessionid is a distinct
-- number from this repo's own `subsession_id` grouping key):
--   1. iRacing's own results page for that race (we store just the real
--      iRacing subsession id and build the URL — see iracingResultsUrl()
--      in src/lib/results.ts — rather than a full URL, so the link format
--      only needs to be updated in one place if it ever changes).
--   2. A replay download link. Replays are large, so this repo
--      deliberately doesn't host them — this is just a link out to
--      wherever an admin has actually put the file (Google Drive, etc).
--   3. A broadcast video link (almost always YouTube).
--
-- Like champion_photos/round_overrides, this table IS owned by this repo.
-- No FK to curated_rounds/race_scores — same reasoning as round_overrides
-- (see 0005_round_overrides.sql): this repo's migrations don't touch the
-- external results pipeline's own tables.
create table if not exists race_links (
  subsession_id bigint not null,
  race_number integer not null,
  iracing_subsession_id bigint,
  replay_url text,
  broadcast_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (subsession_id, race_number)
);

drop trigger if exists race_links_set_updated_at on race_links;
create trigger race_links_set_updated_at before update on race_links
  for each row execute function set_updated_at();

alter table race_links enable row level security;

drop policy if exists "public read" on race_links;
create policy "public read" on race_links for select using (true);

drop policy if exists "admin write race_links" on race_links;
create policy "admin write race_links" on race_links for insert with check (is_admin());

drop policy if exists "admin update race_links" on race_links;
create policy "admin update race_links" on race_links for update using (is_admin());

drop policy if exists "admin delete race_links" on race_links;
create policy "admin delete race_links" on race_links for delete using (is_admin());
