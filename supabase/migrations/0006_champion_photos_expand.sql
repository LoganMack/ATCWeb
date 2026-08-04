-- Alpha Touring Challenge — champion_photos: 3 slots -> 5 slots
--
-- The public Champions card shows one large photo (slot 0) with smaller
-- ones underneath. With only 3 photos (1 large + 2 small, one row), the
-- photo column often ended up noticeably shorter than the stats/text
-- column next to it, leaving a lot of empty space at the bottom of the
-- card. Adding a second row of 2 more small photos (5 total) gives the
-- photo column more height to work with, closing most of that gap.
--
-- Safe to re-run: drops the old check constraint if present before adding
-- the new one.
alter table champion_photos drop constraint if exists champion_photos_sort_order_check;
alter table champion_photos add constraint champion_photos_sort_order_check check (sort_order >= 0 and sort_order < 5);
