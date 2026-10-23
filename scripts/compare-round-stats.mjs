#!/usr/bin/env node
// Parity check for the round stats tables (unit precompute, BR4.1, BR4.2; plan Step 12.3).
//
// For every ATCn season it builds today's per-driver, per-round values with the existing
// TypeScript builders (src/lib/results), reading production with the public anon key exactly as the
// pages do, then reads round_driver_stats, round_team_stats and round_penalty_points with the same
// key and compares every field for every driver, team and round. Every round is compared,
// exhibition and test rounds included, since the tables store them all. km and corners are not
// stored (they stay in TypeScript), so they are not compared.
//
// Usage:
//   node scripts/compare-round-stats.mjs [--season ATC17] [--out perf-reports] [--examples 20]
//
// The builders are TypeScript with extensionless imports, so the script runs itself again under
// vite-node (installed with vitest) when started with plain node. Read-only: the anon key cannot
// write, and the URL and key are the public values committed in wrangler.jsonc (override with
// PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_ANON_KEY).
//
// Writes perf-reports/round-stats-parity-<timestamp>.md (gitignored). Exit codes: 0 no blocking
// difference, 1 blocking differences or a read failed, 2 usage.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  diffRecords,
  findTopTwoTies,
  groupDifferences,
  markTieOrder,
  renderReport,
} from './compareRoundStatsLib.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), '..');
const CHILD_FLAG = 'ATC_ROUND_STATS_UNDER_VITE_NODE';

const STANDING_FIELDS = [
  'points',
  'wins',
  'podiums',
  'top5s',
  'top10s',
  'poles',
  'starts',
  'lapsLed',
  'laps',
];
const EXTENDED_FIELDS = ['laps', 'lapsLed', 'netPositions', 'incidents', 'bonusPoints', 'penaltyPoints'];
const TEAM_USAGE_FIELDS = ['racesUnderTeam', 'racesScoredForTeam'];
const TEAM_ROUND_FIELDS = ['points', 'starts'];

function parseArgs(argv) {
  const args = { season: null, out: 'perf-reports', examples: 20 };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === '--season' && value) args.season = argv[++i];
    else if (argv[i] === '--out' && value) args.out = argv[++i];
    else if (argv[i] === '--examples' && value && /^\d+$/.test(value)) args.examples = Number(argv[++i]);
    else return null;
  }
  return args;
}

// Under plain node, start this file again under vite-node and pass its exit code on.
function relaunchUnderViteNode() {
  const viteNode = path.join(ROOT, 'node_modules', 'vite-node', 'vite-node.mjs');
  if (!existsSync(viteNode)) {
    console.error('compare-round-stats: vite-node is not installed; run `npm ci` first.');
    process.exit(1);
  }
  const result = spawnSync(process.execPath, [viteNode, SCRIPT, '--', ...process.argv.slice(2)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, [CHILD_FLAG]: '1' },
  });
  if (result.error) {
    console.error('compare-round-stats: could not start vite-node:', result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

function supabaseEnv() {
  const wrangler = readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
  const read = (name) => process.env[name] || new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`).exec(wrangler)?.[1];
  const url = read('PUBLIC_SUPABASE_URL');
  const anonKey = read('PUBLIC_SUPABASE_ANON_KEY');
  if (!url || !anonKey)
    throw new Error('PUBLIC_SUPABASE_URL or PUBLIC_SUPABASE_ANON_KEY not found in wrangler.jsonc');
  return { url, anonKey };
}

async function loadModules() {
  const load = (rel) => import(new URL(rel, import.meta.url).href);
  const [client, seasons, lookups, shared, rows, context, standings, teamStandings, extended, carTeam] =
    await Promise.all([
      load('../src/lib/db/client.ts'),
      load('../src/lib/db/seasons.ts'),
      load('../src/lib/db/lookups.ts'),
      load('../src/lib/results/shared.ts'),
      load('../src/lib/results/rows.ts'),
      load('../src/lib/results/seasonContext.ts'),
      load('../src/lib/results/standings.ts'),
      load('../src/lib/results/teamStandings.ts'),
      load('../src/lib/results/extendedStats.ts'),
      load('../src/lib/results/seasonCarTeam.ts'),
    ]);
  return { client, seasons, lookups, shared, rows, context, standings, teamStandings, extended, carTeam };
}

function standingRecords(kind, seasonName, standingsList) {
  const out = [];
  for (const st of standingsList) {
    for (const [round, rs] of st.roundStats) {
      out.push({
        kind,
        season: seasonName,
        round,
        subject: st.driver.id,
        points: st.roundCells.get(round)?.points ?? null,
        wins: rs.wins,
        podiums: rs.podiums,
        top5s: rs.top5s,
        top10s: rs.top10s,
        poles: rs.poles,
        starts: rs.starts,
        lapsLed: rs.lapsLed,
        laps: rs.laps,
      });
    }
  }
  return out;
}

function storedStandingRecords(kind, seasonName, stored, view) {
  return stored.map((t) => ({
    kind,
    season: seasonName,
    round: t.subsession_id,
    subject: t.driver_id,
    points: view.points(t),
    wins: view.prefix === 'class' ? t.class_wins : t.overall_wins,
    podiums: view.prefix === 'class' ? t.class_podiums : t.overall_podiums,
    top5s: view.prefix === 'class' ? t.class_top5s : t.overall_top5s,
    top10s: view.prefix === 'class' ? t.class_top10s : t.overall_top10s,
    poles: view.pole(t) ? 1 : 0,
    starts: t.starts,
    lapsLed: t.laps_led,
    laps: t.laps,
  }));
}

function extendedRecords(seasonName, extStats, storedDrivers, storedPenalties) {
  const expected = [];
  for (const [driverId, ext] of extStats) {
    for (const [round, er] of ext.byRound) {
      expected.push({
        kind: 'extended',
        season: seasonName,
        round,
        subject: driverId,
        laps: er.laps,
        lapsLed: er.lapsLed,
        netPositions: er.netPositionsChange,
        incidents: er.incidents,
        bonusPoints: er.bonusPoints,
        penaltyPoints: er.penaltyPoints,
      });
    }
  }
  const actual = new Map();
  const blank = (round, subject) => ({
    kind: 'extended',
    season: seasonName,
    round,
    subject,
    laps: 0,
    lapsLed: 0,
    netPositions: 0,
    incidents: 0,
    bonusPoints: 0,
    penaltyPoints: 0,
  });
  for (const t of storedDrivers) {
    actual.set(`${t.subsession_id}|${t.driver_id}`, {
      ...blank(t.subsession_id, t.driver_id),
      laps: t.laps,
      lapsLed: t.laps_led,
      netPositions: t.net_positions,
      incidents: t.incidents,
      bonusPoints: t.bonus_points,
    });
  }
  for (const p of storedPenalties) {
    const key = `${p.subsession_id}|${p.driver_id}`;
    const rec = actual.get(key) ?? blank(p.subsession_id, p.driver_id);
    rec.penaltyPoints = p.penalty_points;
    actual.set(key, rec);
  }
  return { expected, actual: [...actual.values()] };
}

function carTeamRecords(seasonName, carTeamStats, storedDrivers) {
  const expectedCars = [];
  const expectedTeams = [];
  for (const [driverId, extras] of carTeamStats) {
    expectedCars.push({
      kind: 'cars',
      season: seasonName,
      round: 'season',
      subject: driverId,
      cars: Object.fromEntries(extras.cars.map((c) => [c.carName, c.races])),
    });
    for (const t of extras.teams) {
      expectedTeams.push({
        kind: 'team-usage',
        season: seasonName,
        round: 'season',
        subject: `${driverId}|${t.teamId}`,
        racesUnderTeam: t.racesUnderTeam,
        racesScoredForTeam: t.racesScoredForTeam,
      });
    }
  }
  const cars = new Map();
  const teams = new Map();
  for (const t of storedDrivers) {
    const carMap = cars.get(t.driver_id) ?? {};
    for (const [name, races] of Object.entries(t.cars ?? {})) carMap[name] = (carMap[name] ?? 0) + races;
    cars.set(t.driver_id, carMap);
    if (!t.team_id) continue;
    const key = `${t.driver_id}|${t.team_id}`;
    const usage = teams.get(key) ?? { racesUnderTeam: 0, racesScoredForTeam: 0 };
    usage.racesUnderTeam += t.races_under_team;
    usage.racesScoredForTeam += t.races_scored_for_team;
    teams.set(key, usage);
  }
  const actualCars = [...cars].map(([subject, c]) => ({
    kind: 'cars',
    season: seasonName,
    round: 'season',
    subject,
    cars: c,
  }));
  const actualTeams = [...teams].map(([subject, u]) => ({
    kind: 'team-usage',
    season: seasonName,
    round: 'season',
    subject,
    ...u,
  }));
  return { expectedCars, actualCars, expectedTeams, actualTeams };
}

function teamRoundRecords(kind, seasonName, teamStandingsList, storedTeams, competition) {
  const expected = [];
  for (const t of teamStandingsList) {
    for (const [round, c] of t.roundCells) {
      expected.push({
        kind,
        season: seasonName,
        round,
        subject: t.teamId,
        points: c.points,
        starts: t.roundStarts.get(round) ?? 0,
      });
    }
  }
  const actual = storedTeams
    .filter((r) => r.competition === competition)
    .map((r) => ({
      kind,
      season: seasonName,
      round: r.subsession_id,
      subject: r.team_id,
      points: r.points,
      starts: r.starts,
    }));
  return { expected, actual };
}

async function compareSeason(m, env, season, lookups) {
  const { drivers, classes, rulesets, teams } = lookups;
  const none = new Set();
  const ctx = await m.context.getSeasonOverallContext(env, season, none, drivers);
  const byClass = (id) => ctx.overallScores.filter((s) => s.class_id === id);
  const seasonFilter = `season_id=eq.${encodeURIComponent(season.id)}`;
  const [storedDrivers, storedTeams, storedPenalties] = await Promise.all([
    m.client.restGetAll(
      env,
      `round_driver_stats?select=*&${seasonFilter}&order=subsession_id.asc,driver_id.asc`,
    ),
    m.client.restGetAll(
      env,
      `round_team_stats?select=*&${seasonFilter}&order=subsession_id.asc,team_id.asc,competition.asc`,
    ),
    m.client.restGetAll(
      env,
      `round_penalty_points?select=*&${seasonFilter}&order=subsession_id.asc,driver_id.asc`,
    ),
  ]);

  const differences = [];
  const counts = {};
  const add = (kind, expected, actual, fields) => {
    counts[kind] = (counts[kind] ?? 0) + expected.length;
    differences.push(...diffRecords(expected, actual, fields));
  };

  for (const cls of classes) {
    const list = await m.standings.computeSeasonStandings(
      env,
      season,
      cls.id,
      drivers,
      none,
      classes,
      ctx,
      byClass(cls.id),
      rulesets,
    );
    const classTotal = m.rows.rankedByClassTotal(cls.name);
    const view = {
      prefix: 'class',
      points: (t) => (classTotal ? t.class_points : t.overall_points),
      pole: (t) => (cls.name === 'Alpha' ? t.overall_pole : t.class_pole),
    };
    const kind = `class:${cls.name}`;
    const stored = storedDrivers.filter((t) => t.class_id === cls.id);
    add(
      kind,
      standingRecords(kind, season.name, list),
      storedStandingRecords(kind, season.name, stored, view),
      STANDING_FIELDS,
    );
  }

  const overall = await m.standings.computeOverallSeasonStandings(env, season, drivers, none, ctx, rulesets);
  const overallView = { prefix: 'overall', points: (t) => t.overall_points, pole: (t) => t.overall_pole };
  add(
    'overall',
    standingRecords('overall', season.name, overall),
    storedStandingRecords('overall', season.name, storedDrivers, overallView),
    STANDING_FIELDS,
  );

  const ext = await m.extended.getSeasonDriverExtendedStats(
    env,
    season,
    none,
    drivers,
    ctx,
    [],
    [],
    new Map(),
  );
  const e = extendedRecords(season.name, ext, storedDrivers, storedPenalties);
  add('extended', e.expected, e.actual, EXTENDED_FIELDS);

  const carTeam = await m.carTeam.getSeasonCarTeamStats(env, season, none, drivers, teams, [], [], ctx);
  const ct = carTeamRecords(season.name, carTeam, storedDrivers);
  add('cars', ct.expectedCars, ct.actualCars, ['cars']);
  const ties = findTopTwoTies(ctx.overallScores, season.name, (s) => s.overall_total);
  const usageDiffs = diffRecords(ct.expectedTeams, ct.actualTeams, TEAM_USAGE_FIELDS);
  counts['team-usage'] = ct.expectedTeams.length;
  differences.push(...markTieOrder(usageDiffs, ties, ['racesScoredForTeam']));

  const competitions = [{ kind: 'team:overall', classId: undefined, competition: 'overall' }];
  for (const name of ['Alpha', 'Delta']) {
    const cls = classes.find((c) => c.name === name);
    if (cls) competitions.push({ kind: `team:${name}`, classId: cls.id, competition: String(cls.id) });
  }
  for (const c of competitions) {
    const list = await m.teamStandings.computeTeamSeasonStandings(
      env,
      season,
      none,
      c.classId,
      drivers,
      teams,
      [],
      classes,
      ctx,
      c.classId === undefined ? undefined : byClass(c.classId),
    );
    const t = teamRoundRecords(c.kind, season.name, list, storedTeams, c.competition);
    add(c.kind, t.expected, t.actual, TEAM_ROUND_FIELDS);
  }
  return { differences, counts };
}

async function main() {
  const args = parseArgs(process.argv.slice(2).filter((a) => a !== '--'));
  if (!args) {
    console.error('usage: node scripts/compare-round-stats.mjs [--season ATCn] [--out dir] [--examples n]');
    process.exit(2);
  }
  if (!process.env[CHILD_FLAG]) relaunchUnderViteNode();

  const m = await loadModules();
  const env = supabaseEnv();
  const [allSeasons, drivers, classes, rulesets, teams] = await Promise.all([
    m.seasons.getSeasons(env),
    m.rows.driversSelect(env),
    m.lookups.getDriverClasses(env),
    m.seasons.getScoringRulesets(env),
    m.rows.getTeamsBasic(env),
  ]);
  const seasons = allSeasons
    .filter((s) => m.shared.isChampionshipSeason(s.name))
    .filter((s) => !args.season || s.name.toLowerCase() === args.season.toLowerCase())
    .sort((a, b) => a.number - b.number);
  if (seasons.length === 0) {
    console.error(`compare-round-stats: no championship season${args.season ? ` named ${args.season}` : ''}`);
    process.exit(2);
  }

  const differences = [];
  const recordCounts = {};
  for (const season of seasons) {
    const result = await compareSeason(m, env, season, { drivers, classes, rulesets, teams });
    differences.push(...result.differences);
    for (const [kind, n] of Object.entries(result.counts)) recordCounts[kind] = (recordCounts[kind] ?? 0) + n;
    console.log(`${season.name}: ${result.differences.length} differences`);
  }

  const generatedAt = new Date().toISOString();
  const report = renderReport({
    generatedAt,
    source: env.url,
    seasons: seasons.map((s) => s.name),
    recordCounts,
    differences,
    examples: args.examples,
  });
  const outDir = path.resolve(ROOT, args.out);
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `round-stats-parity-${generatedAt.replace(/[:.]/g, '-')}.md`);
  writeFileSync(file, report);

  const { counts, blocking } = groupDifferences(differences);
  console.log(`Report: ${path.relative(ROOT, file)}`);
  console.log(`Differences by cause: ${JSON.stringify(counts)}`);
  process.exit(blocking === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('compare-round-stats failed:', error);
  process.exit(1);
});
