-- Undoes 20261029120000_driver_privacy_views.sql: drops the eleven masked views, the private hidden-set
-- view and the three helpers. No data is stored in any of them, so nothing is lost.
--
-- If 20261030120000_driver_privacy_contract.sql has been applied, run its down script first: until then
-- the base tables are admin-only to read and the public pages depend on these views. Run this only once
-- no deployed code reads the *_shown views.

drop view public.hall_of_fame_photos_shown;
drop view public.champion_photos_shown;
drop view public.round_penalties_shown;
drop view public.penalties_shown;
drop view public.news_posts_shown;
drop view public.circuit_layouts_shown;
drop view public.kudos_shown;
drop view public.curated_practice_results_shown;
drop view public.curated_qualifying_shown;
drop view public.curated_race_results_shown;
drop view public.drivers_shown;

drop view private.hidden_drivers;

drop function private.hidden_cust_id(uuid);
drop function private.mask_mentions(text, uuid[]);
drop function private.mask_names(text, text[]);
