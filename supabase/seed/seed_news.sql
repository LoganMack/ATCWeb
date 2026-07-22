-- Test news post, per the content provided when this project was scaffolded.
-- cover_image_url is left NULL: the test image was pasted into chat but never
-- landed as an actual file this session could read, so there's nothing to
-- host yet. Once you have image hosting sorted (Supabase Storage bucket or
-- similar), update this row with the real URL:
--   update news_posts set cover_image_url = '...' where slug = 'swirydowicz-crowned-champion-after-atc17';

insert into news_posts (slug, title, excerpt, body, author_name, published_at)
values (
  'swirydowicz-crowned-champion-after-atc17',
  'Swirydowicz Crowned Champion After ATC17',
  'Wojciech Swirydowicz has become a two-time champion after the conclusion of the season finale at Bathurst on Monday.',
  'Wojciech Swirydowicz has become a two-time champion after the conclusion of the season finale at Bathurst on Monday.',
  'Logan McKinzie',
  '2026-07-22 00:00:00+00'
)
on conflict (slug) do update set
  title = excluded.title,
  excerpt = excluded.excerpt,
  body = excluded.body,
  author_name = excluded.author_name,
  published_at = excluded.published_at;
