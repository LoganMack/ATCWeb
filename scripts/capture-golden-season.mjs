#!/usr/bin/env node
// HISTORICAL, do not run: kept as the record of how tests/fixtures/golden/atc17 was captured. It
// reads race_scores_public, which the scoring contract migration (20261024120000) dropped; a new
// capture has to read race_score_results_public, as tests/fixtures/golden/atc17/view-rows.json does.
//
// Captures a finished season's standings inputs and the standings the live site shows for it, as the
// golden fixture for tests/golden (the pure standings path must reproduce the live page exactly).
//
// Usage:
//   node scripts/capture-golden-season.mjs [--season ATC17] [--site https://alphatouringchallenge.com]
//
// Reads only public data: the Supabase REST API with the public anon key committed in wrangler.jsonc
// (the same key the site ships), and the public /standings/fragment page. Writes, under
// tests/fixtures/golden/<season, lower case>/:
//   inputs.json    the rows the standings code reads, same filters and columns as the live code
//   expected.json  position, driver id and total for the overall view and each class the page offers
// README.md is written by hand afterwards (capture time, the main commit served, row counts).
//
// Every read is paged with Range in 1000-row pages and an explicit unique order. The live code read
// race_scores_public unpaged, so if any of those reads exceeds 1000 rows the live page would be
// truncated: the script stops and reports it instead of writing a fixture.
//
// iRacing customer ids are replaced with stand-ins (1, 2, 3, ... in driver-id order, then entrants
// with no driver row in order of first appearance), the same mapping in drivers, rawResults and
// lapStats, so every join still works. Driver names are kept: the standings page shows them publicly
// and the name is the last tiebreaker.
//
// Exit codes: 0 written, 1 a read failed or a guard tripped, 2 usage.
// Dependency-free: Node 22 built-ins only.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PAGE_SIZE = 1000;

// The selects src/lib used when the fixture was captured, before the results and data-access split; kept
// as they were, since this script is historical.
const RACE_SCORES_CLASS_SELECT =
  'subsession_id,race_number,driver_id,team_id,total_points,class_points,finesse_bonus,points_deduction,pole_bonus,aggression_bonus,lap_led_bonus,fewest_incidents_bonus,fastest_lap_bonus,sprint_sweep_bonus,classified,dsq';
const RACE_SCORES_OVERALL_SELECT =
  'subsession_id,race_number,driver_id,class_id,team_id,finish_points,finesse_bonus,pole_bonus,points_deduction,aggression_bonus,dsq,classified,scored_position';
const ROUND_SUMMARY_SELECT =
  'subsession_id,season_id,start_time,track_name,season_label,round_number,format,strength_of_field,num_drivers';
const RAW_RESULTS_SELECT =
  'subsession_id,race_number,cust_id,finish_position,starting_position,adjusted_position,incidents,laps_complete,laps_led,car_name,interval_ten_thousandths';
const LAP_STATS_SELECT =
  'subsession_id,race_number,cust_id,average_lap_ten_thousandths,best_lap_ten_thousandths';
const PENALTY_SELECT =
  'id,subsession_id,race_number,session_type,driver_id,incident_number,lap,description,' +
  'time_penalty_seconds,points_penalty,penalty_points,is_warning,created_at,' +
  'is_appealed,appeal_result,appeal_time_penalty_seconds,appeal_points_penalty,appeal_penalty_points,' +
  'penalty_offense_links(offense_id),penalty_involved_drivers(driver_id)';

function parseArgs(argv) {
  const args = { season: 'ATC17', site: 'https://alphatouringchallenge.com' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === '--season' || flag === '--site') && value) {
      args[flag.slice(2)] = value;
      i++;
    } else {
      console.error(`Unknown or incomplete argument: ${flag}`);
      console.error('Usage: node scripts/capture-golden-season.mjs [--season ATC17] [--site <url>]');
      process.exit(2);
    }
  }
  return args;
}

/** JSON with // and /* comments and trailing commas, as wrangler.jsonc is written; strings are left alone. */
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function readPublicSupabaseEnv() {
  const vars = parseJsonc(readFileSync('wrangler.jsonc', 'utf8')).vars ?? {};
  const url = vars.PUBLIC_SUPABASE_URL;
  const anonKey = vars.PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey)
    throw new Error('wrangler.jsonc vars has no PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY');
  return { url, anonKey };
}

/** Every row of a PostgREST read, paged like restGetAll. `order` must make the row order unique. */
async function readAll(env, table, query, order) {
  const rows = [];
  const pathAndQuery = `${table}?${query}&order=${order}`;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await fetch(`${env.url}/rest/v1/${pathAndQuery}`, {
      headers: {
        apikey: env.anonKey,
        Authorization: `Bearer ${env.anonKey}`,
        Range: `${offset}-${offset + PAGE_SIZE - 1}`,
      },
    });
    if (!res.ok && res.status !== 206) {
      throw new Error(`REST read failed (${res.status}) on ${table}: ${await res.text()}`);
    }
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function inList(ids) {
  return `in.(${ids.join(',')})`;
}

/** Stand-in customer ids: drivers first in driver-id order, then unrostered entrants by first appearance. */
function buildPseudonyms(drivers, rawResults) {
  const map = new Map();
  for (const d of [...drivers].sort((a, b) => a.id.localeCompare(b.id))) {
    if (d.iracing_cust_id != null && !map.has(d.iracing_cust_id)) map.set(d.iracing_cust_id, map.size + 1);
  }
  const byAppearance = [...rawResults].sort(
    (a, b) =>
      a.subsession_id - b.subsession_id ||
      a.race_number - b.race_number ||
      a.finish_position - b.finish_position,
  );
  for (const r of byAppearance) if (!map.has(r.cust_id)) map.set(r.cust_id, map.size + 1);
  return map;
}

function pseudonymise(map, custId) {
  if (custId == null) return custId;
  const stand = map.get(custId);
  if (stand === undefined) throw new Error('A customer id has no stand-in; refusing to write a real id.');
  return stand;
}

async function captureInputs(env, seasonName) {
  const seasons = await readAll(
    env,
    'seasons',
    `select=id,number,name,is_current,extra_drop_weeks,scoring_ruleset_id,gamma_enabled,delta_enabled&name=eq.${encodeURIComponent(seasonName)}`,
    'id.asc',
  );
  if (seasons.length !== 1)
    throw new Error(`Expected one season named ${seasonName}, found ${seasons.length}`);
  const seasonRow = seasons[0];
  const seasonId = encodeURIComponent(seasonRow.id);

  const [rulesets, classes, driversRaw, excludedRows, overallScores, seasonRounds] = await Promise.all([
    readAll(
      env,
      'scoring_rulesets',
      'select=id,name,rules,is_default,can_drop_final_round',
      'name.asc,id.asc',
    ),
    readAll(env, 'driver_classes', 'select=id,name,sort_order', 'sort_order.asc,id.asc'),
    readAll(env, 'drivers', 'select=id,name,iracing_cust_id&is_ai=eq.false', 'id.asc'),
    readAll(
      env,
      'round_overrides',
      'select=subsession_id&or=(is_exhibition.eq.true,is_test.eq.true)',
      'subsession_id.asc',
    ),
    readAll(
      env,
      'race_scores_public',
      `select=${RACE_SCORES_OVERALL_SELECT}&season_id=eq.${seasonId}`,
      'subsession_id.asc,race_number.asc,driver_id.asc',
    ),
    readAll(
      env,
      'curated_rounds',
      `select=${ROUND_SUMMARY_SELECT}&season_id=eq.${seasonId}`,
      'start_time.desc,subsession_id.desc',
    ),
  ]);

  const scoresByClass = {};
  for (const c of classes) {
    scoresByClass[c.id] = await readAll(
      env,
      'race_scores_public',
      `select=${RACE_SCORES_CLASS_SELECT}&season_id=eq.${seasonId}&class_id=eq.${c.id}`,
      'subsession_id.asc,race_number.asc,driver_id.asc',
    );
  }

  const oversized = [
    ['overallScores', overallScores.length],
    ...Object.entries(scoresByClass).map(([id, rows]) => [`scoresByClass[${id}]`, rows.length]),
  ].filter(([, n]) => n > PAGE_SIZE);
  if (oversized.length > 0) {
    throw new Error(
      `Stopping: ${oversized.map(([k, n]) => `${k} has ${n} rows`).join(', ')}. The live code reads these ` +
        'unpaged, so the live page would be truncated at 1000 rows; report this to the owner.',
    );
  }

  // Same scope as getSeasonOverallContext: the season's subsessions after excluded rounds are removed.
  const excludedRoundIds = [...new Set(excludedRows.map((r) => r.subsession_id))].sort((a, b) => a - b);
  const excluded = new Set(excludedRoundIds);
  const subsessionIds = [...new Set(overallScores.map((s) => s.subsession_id))]
    .filter((id) => !excluded.has(id))
    .sort((a, b) => a - b);

  const [rawResults, lapStats, penalties] =
    subsessionIds.length === 0
      ? [[], [], []]
      : await Promise.all([
          readAll(
            env,
            'curated_race_results',
            `select=${RAW_RESULTS_SELECT}&subsession_id=${inList(subsessionIds)}`,
            'subsession_id.asc,race_number.asc,cust_id.asc',
          ),
          readAll(
            env,
            'curated_race_results',
            `select=${LAP_STATS_SELECT}&subsession_id=${inList(subsessionIds)}`,
            'subsession_id.asc,race_number.asc,cust_id.asc',
          ),
          readAll(
            env,
            'penalties',
            `select=${encodeURIComponent(PENALTY_SELECT)}&subsession_id=${inList(subsessionIds)}`,
            'created_at.asc,id.asc',
          ),
        ]);

  const pseudonyms = buildPseudonyms(driversRaw, rawResults);
  // Standings never read the other DriverBasic fields, so they are fixed values rather than captured.
  const drivers = driversRaw.map((d) => ({
    id: d.id,
    name: d.name,
    car_number: null,
    photo_url: null,
    iracing_cust_id: pseudonymise(pseudonyms, d.iracing_cust_id),
    is_rookie: false,
    nationality_1: null,
    nationality_2: null,
    is_ai: false,
  }));
  const withStandIn = (r) => ({ ...r, cust_id: pseudonymise(pseudonyms, r.cust_id) });

  const { gamma_enabled, delta_enabled, ...season } = seasonRow;
  const inputs = {
    season,
    rulesets,
    classes,
    drivers,
    excludedRoundIds,
    scoresByClass,
    overallScores,
    seasonRounds,
    rawResults: rawResults.map(withStandIn),
    lapStats: lapStats.map(withStandIn),
    penalties,
  };
  inputs.counts = {
    rulesets: rulesets.length,
    classes: classes.length,
    drivers: drivers.length,
    excludedRoundIds: excludedRoundIds.length,
    scoresByClass: Object.fromEntries(Object.entries(scoresByClass).map(([id, rows]) => [id, rows.length])),
    overallScores: overallScores.length,
    seasonRounds: seasonRounds.length,
    rawResults: rawResults.length,
    lapStats: lapStats.length,
    penalties: penalties.length,
  };
  // The standings page only offers a class picker entry for classes that raced this season.
  const offeredClasses = classes.filter(
    (c) => (c.name !== 'Gamma' || gamma_enabled) && (c.name !== 'Delta' || delta_enabled),
  );
  return { inputs, offeredClasses };
}

/** Position, driver id and total for every row of one standings fragment (List mode). */
function parseStandingsRows(html, url) {
  const rows = [];
  const chunks = html.split('data-standings-row').slice(1);
  for (const chunk of chunks) {
    const row = chunk.split('data-detail-row')[0];
    const position = row.match(/data-col="position"[^>]*>\s*([^<]*?)\s*</);
    const driver = row.match(/href="\/drivers\/([^"]+)"/);
    const total = row.match(/data-col="points"[^>]*>\s*([^<]*?)\s*</);
    if (!position || !driver || !total) throw new Error(`Could not parse a standings row on ${url}`);
    rows.push({ position: Number(position[1]), driverId: driver[1], total: Number(total[1]) });
  }
  if (rows.length === 0) throw new Error(`No standings rows on ${url}`);
  for (const r of rows) {
    if (!Number.isFinite(r.position) || !Number.isFinite(r.total))
      throw new Error(`Non-numeric cell on ${url}`);
  }
  return rows;
}

async function captureExpected(site, seasonNumber, offeredClasses) {
  const views = [
    { key: 'overall', className: 'all' },
    ...offeredClasses.map((c) => ({ key: c.name, className: c.name, classId: c.id })),
  ];
  const expected = { site, seasonNumber, views: {} };
  for (const view of views) {
    const url = `${site}/standings/fragment?season=${seasonNumber}&championship=drivers&class=${encodeURIComponent(view.className)}&mode=list`;
    const res = await fetch(url, { headers: { 'User-Agent': 'atc-golden-capture (read-only)' } });
    if (!res.ok) throw new Error(`Fragment request failed (${res.status}) on ${url}`);
    expected.views[view.key] = {
      url,
      classId: view.classId ?? null,
      rows: parseStandingsRows(await res.text(), url),
    };
  }
  return expected;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = readPublicSupabaseEnv();
  const { inputs, offeredClasses } = await captureInputs(env, args.season);
  const expected = await captureExpected(args.site, inputs.season.number, offeredClasses);
  expected.capturedAt = new Date().toISOString();

  const outDir = path.join('tests', 'fixtures', 'golden', args.season.toLowerCase());
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'inputs.json'), `${JSON.stringify(inputs, null, 1)}\n`);
  writeFileSync(path.join(outDir, 'expected.json'), `${JSON.stringify(expected, null, 1)}\n`);

  console.log(`Captured ${args.season} at ${expected.capturedAt} into ${outDir}`);
  console.log(`Row counts: ${JSON.stringify(inputs.counts)}`);
  for (const [key, view] of Object.entries(expected.views))
    console.log(`  ${key}: ${view.rows.length} standings rows`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
