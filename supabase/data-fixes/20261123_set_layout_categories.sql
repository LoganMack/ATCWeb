-- Set the category of every existing circuit layout (FR5.10.4) so the driver profile's Track Type
-- split has data from day one. Categories follow the owner's rules (Oval, Roval, Road Course Long over
-- 4.023 km, Road Course Short, Street Course) and the list the owner approved on 2026-11-23.
-- The ids come from the live layout list read on 2026-11-24 (UTC): 95 layouts.
--
-- Safe to re-run: only layouts whose category is still null change, so a category an admin has
-- already chosen in the editor is never overwritten, and a second run reports UPDATE 0. An id deleted
-- since 2026-11-24 matches nothing. One statement, so the list applies in full or not at all; the
-- column's check constraint refuses any value other than the five keys. The updated_at trigger also
-- stamps each changed row.
--
-- Apply order: only after the PR with migration 20261123120000_layout_category_and_logo_colour has
-- merged and its Deploy workflow run (which runs supabase db push) is green. Applied by hand by the
-- owner in the Supabase SQL editor, or by Claude through the Supabase connection with the owner's
-- explicit OK for this file. CI never runs it.
--
-- Before: select category, count(*) from public.circuit_layouts group by 1 order by 1;
--   Expect one null row. "column category does not exist" means the migration is not live: stop.
-- Run: expect UPDATE 95, less any listed layout an admin has categorised or deleted since.
-- After: the same select. Expected: road_long 39, road_short 35, roval 15, street 6
--   (less those admin edits; the null row drops by the UPDATE count).
-- Spot check: select id, category from public.circuit_layouts where id in (
--   'c90c6498-a6af-4ff3-bff4-334c4ce30cbe', 'a2e3a576-3955-4414-b90e-a70787506db8',
--   '54262563-013b-4517-9132-0a482b257de0', '32967b61-7dca-41d6-b702-6fd710acb114',
--   '09f8df1e-be1a-49d2-a4f3-3585b90ab790') order by id;
--   Expected, one line each for Charlotte Motor Speedway / Roval 2019; Algarve International Circuit /
--   Grand Prix; Lime Rock Park / Grand Prix; Long Beach Street Circuit; Mount Panorama Circuit (low
--   confidence):
--   c90c6498-a6af-4ff3-bff4-334c4ce30cbe roval
--   a2e3a576-3955-4414-b90e-a70787506db8 road_long
--   54262563-013b-4517-9132-0a482b257de0 road_short
--   32967b61-7dca-41d6-b702-6fd710acb114 street
--   09f8df1e-be1a-49d2-a4f3-3585b90ab790 street
--
-- Undo: data fixes have no down script (supabase/down/ is for migrations only). If this list turns out
-- wrong as a whole, undo it with a new dated data fix, through a PR, with the owner's OK and a log row:
--   update public.circuit_layouts as cl set category = null
--   from (values <the same rows as below>) as v(id, category)
--   where cl.id = v.id and cl.category = v.category;
--
-- After applying, add a row to the log in supabase/data-fixes/README.md in a follow-up PR.
update public.circuit_layouts as cl
set category = v.category
from (values
  ('0ef8bc71-750c-4f19-9036-1e4929c29b19'::uuid, 'roval'), -- [Legacy] Phoenix Raceway - 2008 / Road Course
  ('bc4d6aef-0b57-4357-b5ef-4d5cab298d03'::uuid, 'roval'), -- [Legacy] Texas Motor Speedway - 2009 / Road Course Combined
  ('daac346d-8f56-4209-8b94-216f583cad7f'::uuid, 'street'), -- Adelaide Street Circuit / N/A
  ('a2e3a576-3955-4414-b90e-a70787506db8'::uuid, 'road_long'), -- Algarve International Circuit / Grand Prix
  ('2783a07f-c624-41bd-b054-72af45538b66'::uuid, 'road_long'), -- Autódromo Hermanos Rodríguez / Grand Prix
  ('15185a9b-62b7-491b-94d0-33a20affb5d7'::uuid, 'road_long'), -- Autodromo Internazionale del Mugello / Grand Prix
  ('99f39314-8ec6-4616-8d39-9197f5b0a2fc'::uuid, 'road_long'), -- Autodromo Internazionale Enzo e Dino Ferrari / Grand Prix
  ('e2588e98-0b66-488c-a517-dadcfa2de3eb'::uuid, 'road_long'), -- Autódromo José Carlos Pace / Grand Prix
  ('9b999717-6b77-4e54-b8ea-e62a2c524b5c'::uuid, 'roval'), -- Autodromo Nazionale Monza / Combined
  ('cc43ebac-7216-4c5d-ac8b-98167d788100'::uuid, 'road_long'), -- Autodromo Nazionale Monza / Grand Prix
  ('6cd8ae4f-b199-42da-8eae-0626d1c87d0d'::uuid, 'road_short'), -- Autodromo Nazionale Monza / Junior
  ('80e850ae-17db-4b26-a122-5f3361bbd5bd'::uuid, 'road_short'), -- Barber Motorsports Park / Full Course
  ('09e16bd3-41f0-4bfa-b766-59477fb61662'::uuid, 'road_short'), -- Brands Hatch Circuit / Grand Prix
  ('08b08d5d-afb1-4689-ac9e-c8518fc2b3b1'::uuid, 'road_short'), -- Canadian Tire Motorsports Park / N/A
  ('c90c6498-a6af-4ff3-bff4-334c4ce30cbe'::uuid, 'roval'), -- Charlotte Motor Speedway / Roval 2019
  ('26a9fb3a-2706-4e87-bf1d-61fc7aebd7d2'::uuid, 'roval'), -- Charlotte Motor Speedway / Roval 2025
  ('da15c520-e7ee-48c0-b297-691f31560c64'::uuid, 'roval'), -- Charlotte Motor Speedway / Roval No Chicanes
  ('7fe0fd55-9e04-41a8-bc05-5610834d140b'::uuid, 'street'), -- Chicago Street Course / 2023 Cup
  ('c52cd151-99e8-491d-aaf0-d2a04d24b6f4'::uuid, 'road_short'), -- Circuit de Lédenon / N/A
  ('e7ba0dc7-c976-4b55-8cc2-1fe202f61fd8'::uuid, 'road_long'), -- Circuit de Spa-Francorchamps / Bike
  ('3ce68ed8-43e3-475f-bef1-dd9912f55c4a'::uuid, 'road_long'), -- Circuit de Spa-Francorchamps / Grand Prix Pits
  ('1bb3183a-d7c3-45d5-873f-e42f9417b842'::uuid, 'road_long'), -- Circuit Gilles Villeneuve / N/A
  ('81920497-65a6-4e29-81ea-a43f6992d26d'::uuid, 'road_long'), -- Circuit of the Americas / Grand Prix
  ('3c88d92c-1804-4f20-9521-e4c2fe22fd9e'::uuid, 'road_short'), -- Circuit of the Americas / NASCAR West
  ('58bd3e34-0743-4017-856a-6cb717b48460'::uuid, 'road_long'), -- Circuit Park Zandvoort / Grand Prix
  ('ea821013-57f2-4198-bb96-808c81cf20b4'::uuid, 'road_long'), -- Circuit Zandvoort / Grand Prix
  ('575e96a0-4676-4fb2-b062-8d94c3dfaeaf'::uuid, 'road_short'), -- Circuit Zolder / Grand Prix
  ('45acc7d0-1e1c-4d7b-bb07-0fb48e98fa25'::uuid, 'roval'), -- Daytona International Speedway / NASCAR Road
  ('ef99e9ba-a986-4df9-915e-714d8fdf438f'::uuid, 'roval'), -- Daytona International Speedway / Road Course
  ('107a2b2e-a24c-448d-987b-a19d38331843'::uuid, 'roval'), -- Daytona International Speedway / Road Course - 2008
  ('9c3c3695-8bca-4f91-8228-a949a26832f2'::uuid, 'street'), -- Detroit Grand Prix at Belle Isle / Belle Isle
  ('f0db8a78-5b0d-4457-9c10-5bcab98f45a8'::uuid, 'road_short'), -- Donington Park Racing Circuit / Grand Prix
  ('1fcf9a4d-b636-4692-9a51-95bc7e882529'::uuid, 'road_short'), -- Donington Park Racing Circuit / National
  ('e3937de9-438b-487c-8810-55e7b60577b9'::uuid, 'road_long'), -- Fuji International Speedway / Grand Prix
  ('38af8e2f-c67c-4ead-8642-4b042b9a52ef'::uuid, 'road_long'), -- Fuji International Speedway / No Chicane
  ('1d00f963-67f2-4d3e-b3a0-965ad7fae151'::uuid, 'road_long'), -- Hockenheimring Baden-Württemberg / Grand Prix
  ('901333ea-7a37-404e-946b-54e089d9ff03'::uuid, 'road_short'), -- Hockenheimring Baden-Württemberg / National A
  ('a1a5a985-4701-4065-b0ef-303275e9ccde'::uuid, 'road_long'), -- Hockenheimring Baden-Württemberg / Outer
  ('8ecd4b74-7582-445f-9108-c005a946435e'::uuid, 'roval'), -- Homestead Miami Speedway / Road Course B
  ('a46f38b8-439c-4239-b299-288b4f37a562'::uuid, 'road_long'), -- Hungaroring / N/A
  ('c807f8f1-244d-4d74-a232-6324a9aef1c9'::uuid, 'roval'), -- Indianapolis Motor Speedway / Bike - 2009
  ('43728ebe-5c85-401f-9698-367aa163e811'::uuid, 'roval'), -- Indianapolis Motor Speedway / Road Course - 2009
  ('24c5a3bc-31b9-44cd-b22c-c96111558f25'::uuid, 'road_short'), -- Knockhill Racing Circuit / International
  ('17737d45-1057-4f66-b8f6-fe72d87234f8'::uuid, 'road_short'), -- Lime Rock Park / Classic
  ('54262563-013b-4517-9132-0a482b257de0'::uuid, 'road_short'), -- Lime Rock Park / Grand Prix
  ('e09c326d-b3c0-48dc-8552-f2b4b3e2b2bc'::uuid, 'road_short'), -- Lime Rock Park / West Bend Chicane
  ('32967b61-7dca-41d6-b702-6fd710acb114'::uuid, 'street'), -- Long Beach Street Circuit / N/A
  ('dd591b99-ee3b-41ae-91a6-2cac134fdb3e'::uuid, 'road_long'), -- Miami International Autodrome / Grand Prix
  ('a4cdd8db-fca3-4f89-862d-462722d58db9'::uuid, 'road_short'), -- Mid-Ohio Sports Car Course / Full Course
  ('eac9cf12-04dd-4047-9d31-fcb0a36ef900'::uuid, 'road_short'), -- Mobility Resort Motegi / East
  ('0ffdce2f-be5f-4a6c-832e-cbff835f1d05'::uuid, 'road_long'), -- Mobility Resort Motegi / Grand Prix
  ('3d4611d1-edf0-4fca-9fe9-c322886ce533'::uuid, 'road_short'), -- Motorsport Arena Oschersleben / Grand Prix
  ('09f8df1e-be1a-49d2-a4f3-3585b90ab790'::uuid, 'street'), -- Mount Panorama Circuit / N/A
  ('5963dccc-9b3b-44d7-aa0d-b368d5c7e635'::uuid, 'roval'), -- New Hampshire Motor Speedway / Road Course with North Oval
  ('3b8a05cc-b4d4-4539-b7c8-e902f5a9da91'::uuid, 'roval'), -- New Hampshire Motor Speedway / Road Course with South Oval
  ('f39694d0-0a4a-4a81-a877-3d8b725a31e6'::uuid, 'road_long'), -- Nürburgring Combined / Gesamtstrecke 24h
  ('a94d985f-e98d-4e1d-9bfa-8831e31b8326'::uuid, 'road_long'), -- Nürburgring Combined / Gesamtstrecke VLN
  ('abb92a7b-6132-4aab-ac02-ffe6f86f3fa3'::uuid, 'road_long'), -- Nürburgring Grand-Prix-Strecke / BES/WEC
  ('19ee5964-4f6e-4aa9-9e92-fef684be8ea6'::uuid, 'road_short'), -- Nürburgring Grand-Prix-Strecke / Sprintstrecke
  ('834e97dc-b403-4ced-947c-b07a64c5cf35'::uuid, 'road_short'), -- Okayama International Circuit / Full Course
  ('77d38907-8aef-4687-ac0d-66179b643b0c'::uuid, 'road_short'), -- Oran Park Raceway / Grand Prix
  ('4e66b8c9-8f26-4e15-b287-7fa8a16d2f7b'::uuid, 'road_long'), -- Oulton Park Circuit / International
  ('3b792414-48e4-4b86-9baa-117b247891a2'::uuid, 'road_long'), -- Oulton Park Circuit / Intl w/no Chicanes
  ('078aa83b-d19a-4823-94ba-2935eb25e90a'::uuid, 'road_long'), -- Oulton Park Circuit / Intl w/out Hislop
  ('9d43d847-1137-4ff2-b105-e028bef66bf0'::uuid, 'road_long'), -- Phillip Island Circuit / N/A
  ('140957b2-3dee-47ee-8341-b54a76a10c26'::uuid, 'road_short'), -- Portland International Raceway / Full Circuit
  ('c8687fad-1773-48e6-ad5f-c86404a2588d'::uuid, 'road_long'), -- Red Bull Ring / Grand Prix
  ('a40f3594-03c7-4e85-a04f-7ee170b77684'::uuid, 'road_short'), -- Red Bull Ring / National
  ('1a8aab11-890f-44c8-ab56-196fd50eedef'::uuid, 'road_long'), -- Road America / Bend
  ('55253934-aded-4215-8d6a-3912a659e22a'::uuid, 'road_long'), -- Road America / Full Course
  ('388166c4-d094-43e0-84f4-133153ec131a'::uuid, 'road_long'), -- Road Atlanta / Full Course
  ('516db701-8950-4f02-af09-c5542d80479a'::uuid, 'road_short'), -- Rudskogen Motorsenter / N/A
  ('080673dd-236a-4457-8b4c-f7b8d4d81bd2'::uuid, 'road_short'), -- Sandown International Motor Raceway / N/A
  ('8d88862b-0ec1-4f19-b401-72edf4f6427a'::uuid, 'road_short'), -- Sebring International Raceway / Club
  ('304e0477-7ce1-498f-b061-c8743506207c'::uuid, 'road_long'), -- Sebring International Raceway / International
  ('699ab7f6-6062-43cd-9f00-d2c20bae62c3'::uuid, 'road_short'), -- Sebring International Raceway / Modified
  ('5c890b27-b851-413e-8610-f6ca582da168'::uuid, 'road_long'), -- Silverstone Circuit / Grand Prix
  ('cbc26af1-8642-4b6f-8937-665e3b9885b2'::uuid, 'road_short'), -- Silverstone Circuit / National
  ('1ba81aca-2d9b-40cb-86dc-499c4cf6ed00'::uuid, 'road_long'), -- Sonoma Raceway / Cup Historic
  ('85f81a02-10e1-4a11-8749-7c629316544a'::uuid, 'road_short'), -- Sonoma Raceway / NASCAR Short
  ('61de31ee-c6fa-4e8d-83cc-a69ffcd393f0'::uuid, 'road_long'), -- Sonoma Raceway / Sportscar
  ('5b0f6f5b-79ae-4b3f-b9f6-791f65448fe4'::uuid, 'street'), -- St. Petersburg Grand Prix / Grand Prix
  ('b7c5d469-95a0-4da4-a36a-7d9cee34dd3c'::uuid, 'road_short'), -- Summit Point Raceway / Summit Point Raceway
  ('a9e0bc0a-0154-4fec-b03d-7a64cf00c992'::uuid, 'road_short'), -- Suzuka International Racing Course / East
  ('20b32e5b-c508-4cab-9b01-be30b329133b'::uuid, 'road_long'), -- Suzuka International Racing Course / Grand Prix
  ('24ce3af1-9f4a-4047-87e9-4ed6220079cd'::uuid, 'road_short'), -- Thruxton Circuit / N/A
  ('d49c1883-bc3d-43e4-9cf3-d32270d26513'::uuid, 'road_short'), -- Tsukuba Circuit / 2000 Full
  ('780cfc11-f040-4303-9afe-b105d20b8d6f'::uuid, 'road_short'), -- Tsukuba Circuit / 2000 Short
  ('fea90de2-4793-4b8a-8ebd-67249b6785d1'::uuid, 'road_long'), -- Virginia International Raceway / Full Course
  ('fa41b5b4-810d-4fdc-86e1-48e014907b42'::uuid, 'road_long'), -- Virginia International Raceway / Grand Course
  ('b83592cf-fa10-487e-8490-58658be2162b'::uuid, 'road_long'), -- Watkins Glen International / Boot
  ('1b74568c-5504-4c6d-a6a7-22750942f5f2'::uuid, 'road_long'), -- Watkins Glen International / Classic Boot
  ('d51688ac-67f1-43ef-80f9-1ce84cfba096'::uuid, 'road_short'), -- Watkins Glen International / Cup
  ('c3eed64e-3d85-4149-8ccd-be004fa3451e'::uuid, 'road_short'), -- WeatherTech Raceway at Laguna Seca / Full Course
  ('a432065d-4270-4921-9bdd-231eb035b009'::uuid, 'roval') -- World Wide Technology Raceway (Gateway) / Road Course
) as v(id, category)
where cl.id = v.id
  and cl.category is null;
