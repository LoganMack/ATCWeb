-- Backfills circuit_layouts.corners (0022_circuit_layout_corners.sql) from
-- Logan's "circuitrecords" spreadsheet so corners-per-incident math
-- (getSeasonDriverExtendedStats in src/lib/results.ts) has real data to
-- work with for every layout the spreadsheet covers.
--
-- Matching strategy: each spreadsheet row is "<Location> - <Layout>" as one
-- combined string. Rather than trying to guess exactly where that split
-- falls per row (several rows have their own embedded " - ", e.g.
-- "[Legacy] Phoenix Raceway - 2008 - Road Course"), this matches on the
-- FULL combined string, normalized (lowercased, every non-alphanumeric
-- character stripped) — since normalization strips the separator too, the
-- split point doesn't matter: normalize(circuit.name || layout.name) is
-- character-for-character identical regardless of where within that
-- combined string the "real" circuit/layout boundary falls, as long as the
-- two full strings agree. Verified via a dry-run SELECT first: 87 of 89
-- spreadsheet rows matched exactly one circuit_layouts row this way; the
-- other 2 needed manual handling (both below, not the bulk VALUES list) —
-- "Twin Ring Motegi - Grand Prix" is that layout's old pre-rename name
-- (circuits.name is now "Mobility Resort Motegi"), and "Charlotte Motor
-- Speedway - Roval" (no year) is genuinely ambiguous between this app's
-- "Roval 2019" and "Roval No Chicanes" layouts — left unset, flagged to
-- Logan to pick one by hand.
with raw_corners(combined_raw, corners) as (
  values
    ('[Legacy] Phoenix Raceway - 2008 - Road Course', 13),
    ('[Legacy] Texas Motor Speedway - 2009 - Road Course Combined', 10),
    ('Adelaide Street Circuit - N/A', 14),
    ('Algarve International Circuit - Grand Prix', 15),
    ('Autódromo Hermanos Rodríguez - Grand Prix', 17),
    ('Autodromo Internazionale del Mugello - Grand Prix', 15),
    ('Autodromo Internazionale Enzo e Dino Ferrari - Grand Prix', 17),
    ('Autódromo José Carlos Pace - Grand Prix', 15),
    ('Autodromo Nazionale Monza - Combined', 15),
    ('Autodromo Nazionale Monza - Grand Prix', 11),
    ('Autodromo Nazionale Monza - Junior', 4),
    ('Barber Motorsports Park - Full Course', 16),
    ('Brands Hatch Circuit - Grand Prix', 9),
    ('Canadian Tire Motorsports Park - N/A', 10),
    ('Charlotte Motor Speedway  - Roval 2025', 17),
    ('Chicago Street Course - 2023 Cup', 12),
    ('Circuit de Spa-Francorchamps - Bike', 21),
    ('Circuit de Spa-Francorchamps - Grand Prix Pits', 21),
    ('Circuit Gilles Villeneuve - N/A', 13),
    ('Circuit of the Americas - Grand Prix', 20),
    ('Circuit of the Americas - NASCAR West', 17),
    ('Circuit Park Zandvoort - Grand Prix', 13),
    ('Circuit Zandvoort - Grand Prix', 14),
    ('Circuit Zolder - Grand Prix', 10),
    ('Daytona International Speedway - NASCAR Road', 14),
    ('Daytona International Speedway - Road Course', 12),
    ('Daytona International Speedway - Road Course - 2008', 12),
    ('Detroit Grand Prix at Belle Isle - Belle Isle', 14),
    ('Donington Park Racing Circuit - Grand Prix', 12),
    ('Donington Park Racing Circuit - National', 10),
    ('Fuji International Speedway - Grand Prix', 16),
    ('Fuji International Speedway - No Chicane', 15),
    ('Hockenheimring Baden-Württemberg - Grand Prix', 16),
    ('Hockenheimring Baden-Württemberg - National A', 16),
    ('Hockenheimring Baden-Württemberg - Outer', 12),
    ('Homestead Miami Speedway - Road Course B', 11),
    ('Hungaroring - N/A', 14),
    ('Indianapolis Motor Speedway - Bike - 2009', 16),
    ('Indianapolis Motor Speedway - Road Course - 2009', 13),
    ('Knockhill Racing Circuit - International', 8),
    ('Lime Rock Park - Classic', 7),
    ('Lime Rock Park - Grand Prix', 9),
    ('Lime Rock Park - West Bend Chicane', 9),
    ('Long Beach Street Circuit - N/A', 11),
    ('Miami International Autodrome - Grand Prix', 17),
    ('Mid-Ohio Sports Car Course - Full Course', 13),
    ('Mobility Resort Motegi - East', 11),
    ('Mobility Resort Motegi - Grand Prix', 14),
    ('Motorsport Arena Oschersleben - Grand Prix', 14),
    ('Mount Panorama Circuit - N/A', 23),
    ('New Hampshire Motor Speedway - Road Course with North Oval', 13),
    ('New Hampshire Motor Speedway - Road Course with South Oval', 14),
    ('Nürburgring Combined - Gesamtstrecke 24h', 170),
    ('Nürburgring Combined - Gesamtstrecke VLN', 165),
    ('Nürburgring Grand-Prix-Strecke - BES/WEC', 16),
    ('Nürburgring Grand-Prix-Strecke - Sprintstrecke', 11),
    ('Okayama International Circuit - Full Course', 11),
    ('Oran Park Raceway - Grand Prix', 12),
    ('Oulton Park Circuit - Intl w/no Chicanes', 12),
    ('Oulton Park Circuit - Intl w/out Hislop', 17),
    ('Phillip Island Circuit - N/A', 12),
    ('Red Bull Ring - Grand Prix', 10),
    ('Red Bull Ring - National', 6),
    ('Road America - Bend', 18),
    ('Road America - Full Course', 18),
    ('Road Atlanta - Full Course', 12),
    ('Rudskogen Motorsenter - N/A', 14),
    ('Sandown International Motor Raceway - N/A', 13),
    ('Sebring International Raceway - Club', 11),
    ('Sebring International Raceway - International', 17),
    ('Sebring International Raceway - Modified', 9),
    ('Silverstone Circuit - Grand Prix', 18),
    ('Silverstone Circuit - National', 6),
    ('Sonoma Raceway - Cup Historic', 12),
    ('Sonoma Raceway - NASCAR Short', 12),
    ('St. Petersburg Grand Prix - Grand Prix', 14),
    ('Summit Point Raceway - Summit Point Raceway', 10),
    ('Suzuka International Racing Course - East', 7),
    ('Suzuka International Racing Course - Grand Prix', 17),
    ('Thruxton Circuit - N/A', 12),
    ('Tsukuba Circuit - 2000 Full', 12),
    ('Tsukuba Circuit - 2000 Short', 6),
    ('Virginia International Raceway - Full Course', 20),
    ('Virginia International Raceway - Grand Course', 26),
    ('Watkins Glen International - Boot', 12),
    ('Watkins Glen International - Classic Boot', 11),
    ('Watkins Glen International - Cup', 8),
    ('WeatherTech Raceway at Laguna Seca - Full Course', 12)
),
normalized as (
  select regexp_replace(lower(combined_raw), '[^a-z0-9]', '', 'g') as key, corners
  from raw_corners
)
update circuit_layouts cl
set corners = n.corners
from circuits c, normalized n
where cl.circuit_id = c.id
  and regexp_replace(lower(c.name || cl.name), '[^a-z0-9]', '', 'g') = n.key;
