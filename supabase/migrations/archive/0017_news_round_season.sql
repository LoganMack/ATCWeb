-- Alpha Touring Challenge — news posts: link to a round, tag with a season
--
-- Two additions to `news_posts` (this repo's own table, see 0001_init.sql):
--
-- 1. `round_subsession_id` — optionally links a post to one round's results
--    (curated_rounds.subsession_id). Same pattern as round_overrides
--    (0005_round_overrides.sql) and race_links (0007_race_links.sql):
--    deliberately NO foreign key to curated_rounds, since that table is
--    populated by the external iRacing-results import pipeline and this
--    repo's migrations must never touch the pipeline's own tables' shape —
--    just a plain subsession_id the app code joins on. When set, the
--    article shows a link to that round's results at the top and a
--    live-computed race recap at the bottom (see src/lib/newsRecap.ts) —
--    the recap is never stored text, so it can't go stale if a penalty is
--    logged against that round after the post is published.
--
-- 2. `season_label` — a free-text season tag (matching the free-text
--    `curated_rounds.season_label` the rest of the app already reads, e.g.
--    "ATC17" or an exhibition season's own name), NOT a foreign key to
--    `seasons`. Deliberately text rather than a strict FK picker so a post
--    can be tagged with any season — including non-points/exhibition ones
--    that may not warrant a full `seasons` row of their own — and so the
--    admin form and the public filter dropdown can both just work off
--    whatever distinct labels are actually in use, no schema change needed
--    to add a new one later. (`news_posts.season_id`, a `seasons` FK added
--    back in 0001_init.sql, has never been read or written by any app code
--    — left as-is/unused rather than dropped, in case something outside
--    this repo depends on it.)
alter table news_posts add column if not exists round_subsession_id bigint;
alter table news_posts add column if not exists season_label text;

create index if not exists news_posts_round_subsession_idx on news_posts (round_subsession_id);
create index if not exists news_posts_season_label_idx on news_posts (season_label);
