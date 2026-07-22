-- Test news post, per the content provided when this project was scaffolded.
-- cover_image_url points at a static asset shipped in the site itself
-- (public/images/news/swirydowicz-champion-atc17.jpg) rather than Supabase
-- Storage -- simplest option for images that live alongside the code and
-- don't need to be swapped without a deploy. If you'd rather manage news
-- images from Supabase directly later, create a Storage bucket and swap
-- this for its public URL.

insert into news_posts (slug, title, excerpt, body, author_name, published_at, cover_image_url)
values (
  'swirydowicz-crowned-champion-after-atc17',
  'Swirydowicz Crowned Champion After ATC17',
  'Wojciech Swirydowicz has become a two-time champion after the conclusion of the season finale at Bathurst on Monday.',
  'Wojciech Swirydowicz has become a two-time champion after the conclusion of the season finale at Bathurst on Monday.',
  'Logan McKinzie',
  '2026-07-22 00:00:00+00',
  '/images/news/swirydowicz-champion-atc17.jpg'
)
on conflict (slug) do update set
  title = excluded.title,
  excerpt = excluded.excerpt,
  body = excluded.body,
  author_name = excluded.author_name,
  published_at = excluded.published_at,
  cover_image_url = excluded.cover_image_url;
