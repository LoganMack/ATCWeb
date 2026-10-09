-- Alpha Touring Challenge — circuit coordinates for the Calendar's Map view
--
-- The Map view plots each event at its circuit's latitude/longitude. The free-text
-- `location` column can't be plotted on its own, so circuits get two optional
-- numeric columns (editable on /admin/circuits/<id>).
--
-- The backfill below fills in coordinates for the circuits in the database as of
-- this migration, matched by exact name, and ONLY where latitude is still null.
-- It also fills `location` where that is blank, and never overwrites a location
-- someone already typed. Coordinates are approximate (within a few km), which is
-- plenty for a world map. Review the list before running; a name that doesn't
-- match any row is simply skipped.

alter table circuits add column if not exists latitude double precision;
alter table circuits add column if not exists longitude double precision;

alter table circuits drop constraint if exists circuits_latitude_range;
alter table circuits add constraint circuits_latitude_range check (latitude is null or (latitude between -90 and 90));
alter table circuits drop constraint if exists circuits_longitude_range;
alter table circuits add constraint circuits_longitude_range check (longitude is null or (longitude between -180 and 180));

update circuits c
set latitude = v.lat,
    longitude = v.lng,
    location = coalesce(nullif(btrim(c.location), ''), v.loc)
from (values
  ('[Legacy] Phoenix Raceway - 2008', 'Avondale, Arizona, USA', 33.3751, -112.3113),
  ('[Legacy] Texas Motor Speedway - 2009', 'Fort Worth, Texas, USA', 33.0372, -97.2817),
  ('Adelaide Street Circuit', 'Adelaide, Australia', -34.929, 138.617),
  ('Algarve International Circuit', 'Portimão, Portugal', 37.2272, -8.6267),
  ('Autódromo Hermanos Rodríguez', 'Mexico City, Mexico', 19.4042, -99.0907),
  ('Autodromo Internazionale del Mugello', 'Scarperia e San Piero, Tuscany, Italy', 43.9975, 11.3719),
  ('Autodromo Internazionale Enzo e Dino Ferrari', 'Imola, Emilia-Romagna, Italy', 44.3439, 11.7167),
  ('Autódromo José Carlos Pace', 'São Paulo, Brazil', -23.7036, -46.6997),
  ('Autodromo Nazionale Monza', 'Monza, Lombardy, Italy', 45.6156, 9.2811),
  ('Barber Motorsports Park', 'Birmingham, Alabama, USA', 33.5326, -86.6195),
  ('Brands Hatch Circuit', 'West Kingsdown, Kent, England', 51.3569, 0.2631),
  ('Canadian Tire Motorsports Park', 'Bowmanville, Ontario, Canada', 44.0517, -78.6753),
  ('Charlotte Motor Speedway', 'Concord, North Carolina, USA', 35.3519, -80.6828),
  ('Chicago Street Course', 'Chicago, Illinois, USA', 41.8758, -87.6189),
  ('Circuit de Lédenon', 'Lédenon, Occitanie, France', 43.9486, 4.4733),
  ('Circuit de Spa-Francorchamps', 'Stavelot, Belgium', 50.4372, 5.9714),
  ('Circuit Gilles Villeneuve', 'Montreal, Quebec, Canada', 45.5, -73.5228),
  ('Circuit of the Americas', 'Austin, Texas, USA', 30.1328, -97.6411),
  ('Circuit Park Zandvoort', 'Zandvoort, Netherlands', 52.3888, 4.5409),
  ('Circuit Zandvoort', 'Zandvoort, Netherlands', 52.3888, 4.5409),
  ('Circuit Zolder', 'Heusden-Zolder, Belgium', 50.9894, 5.2564),
  ('Daytona International Speedway', 'Daytona Beach, Florida, USA', 29.1852, -81.0705),
  ('Detroit Grand Prix at Belle Isle', 'Detroit, Michigan, USA', 42.3392, -82.9803),
  ('Donington Park Racing Circuit', 'Castle Donington, Leicestershire, England', 52.8306, -1.3754),
  ('Fuji International Speedway', 'Oyama, Shizuoka, Japan', 35.3717, 138.9269),
  ('Hockenheimring Baden-Württemberg', 'Hockenheim, Germany', 49.3278, 8.5658),
  ('Homestead Miami Speedway', 'Homestead, Florida, USA', 25.4512, -80.4087),
  ('Hungaroring', 'Mogyoród, Hungary', 47.5789, 19.2486),
  ('Indianapolis Motor Speedway', 'Speedway, Indiana, USA', 39.795, -86.2347),
  ('Knockhill Racing Circuit', 'Fife, Scotland', 56.1306, -3.5083),
  ('Lime Rock Park', 'Lakeville, Connecticut, USA', 41.9279, -73.3836),
  ('Long Beach Street Circuit', 'Long Beach, California, USA', 33.7653, -118.1895),
  ('Miami International Autodrome', 'Miami Gardens, Florida, USA', 25.9581, -80.2389),
  ('Mid-Ohio Sports Car Course', 'Lexington, Ohio, USA', 40.6867, -82.6361),
  ('Mobility Resort Motegi', 'Motegi, Tochigi, Japan', 36.5308, 140.2269),
  ('Motorsport Arena Oschersleben', 'Oschersleben, Germany', 52.0272, 11.2797),
  ('Mount Panorama Circuit', 'Bathurst, New South Wales, Australia', -33.4469, 149.5558),
  ('New Hampshire Motor Speedway', 'Loudon, New Hampshire, USA', 43.3622, -71.4614),
  ('Nürburgring Combined', 'Nürburg, Germany', 50.3356, 6.9475),
  ('Nürburgring Grand-Prix-Strecke', 'Nürburg, Germany', 50.3356, 6.9475),
  ('Okayama International Circuit', 'Mimasaka, Okayama, Japan', 34.9156, 134.2211),
  ('Oran Park Raceway', 'Narellan, New South Wales, Australia', -34.0036, 150.7406),
  ('Oulton Park Circuit', 'Little Budworth, Cheshire, England', 53.1775, -2.6139),
  ('Phillip Island Circuit', 'Phillip Island, Victoria, Australia', -38.5026, 145.2311),
  ('Portland International Raceway', 'Portland, Oregon, USA', 45.595, -122.6933),
  ('Red Bull Ring', 'Spielberg, Austria', 47.2197, 14.7647),
  ('Road America', 'Elkhart Lake, Wisconsin, USA', 43.7978, -87.9894),
  ('Road Atlanta', 'Braselton, Georgia, USA', 34.1464, -83.8186),
  ('Rudskogen Motorsenter', 'Rakkestad, Norway', 59.3797, 11.2989),
  ('Sandown International Motor Raceway', 'Springvale, Victoria, Australia', -37.9453, 145.1613),
  ('Sebring International Raceway', 'Sebring, Florida, USA', 27.4504, -81.355),
  ('Silverstone Circuit', 'Silverstone, Northamptonshire, England', 52.0786, -1.0169),
  ('Sonoma Raceway', 'Sonoma, California, USA', 38.1608, -122.4547),
  ('St. Petersburg Grand Prix', 'St. Petersburg, Florida, USA', 27.765, -82.6322),
  ('Summit Point Raceway', 'Summit Point, West Virginia, USA', 39.26, -77.98),
  ('Suzuka International Racing Course', 'Suzuka, Mie, Japan', 34.8431, 136.5407),
  ('Thruxton Circuit', 'Andover, Hampshire, England', 51.2075, -1.605),
  ('Tsukuba Circuit', 'Shimotsuma, Ibaraki, Japan', 36.1744, 139.9186),
  ('Twin Ring Motegi', 'Motegi, Tochigi, Japan', 36.5308, 140.2269),
  ('Virginia International Raceway', 'Alton, Virginia, USA', 36.5681, -79.2064),
  ('Watkins Glen International', 'Watkins Glen, New York, USA', 42.3369, -76.9272),
  ('WeatherTech Raceway at Laguna Seca', 'Monterey, California, USA', 36.5844, -121.7536),
  ('World Wide Technology Raceway (Gateway)', 'Madison, Illinois, USA', 38.6506, -90.1356)
) as v(name, loc, lat, lng)
where c.name = v.name
  and c.latitude is null;
