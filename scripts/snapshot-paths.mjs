#!/usr/bin/env node
// The page list for the page-loading snapshot comparison (BR1.3): every page whose numbers now come from
// the stored round stats, for scripts/snapshot-pages.mjs --paths-file.
//
// Usage:
//   node scripts/snapshot-paths.mjs > perf-reports/snapshot-paths.txt
//   node scripts/snapshot-paths.mjs --self-test
//
// Lists, one path per line:
//   * every driver profile (non-AI drivers, as a signed-out visitor reads them);
//   * every ATCn season's standings: overall and each class it ran, as List and Matrix, plus the Teams
//     championship (and Delta Team where that season ran it);
//   * home, driver stats per class, hall of fame, team stats (overall and Delta) and champions (each class,
//     Alpha Team and Delta Team);
//   * a sample of results pages: the newest RESULTS_SAMPLE rounds.
// Reads production with the public anon key from wrangler.jsonc (or PUBLIC_SUPABASE_URL and
// PUBLIC_SUPABASE_ANON_KEY): read-only GETs, nothing is written. Dependency-free: Node 22 built-ins only.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const RESULTS_SAMPLE = 10;
const CLASS_NAMES = ['Alpha', 'Gamma', 'Delta'];

const isChampionshipSeason = (name) => /^ATC\d+$/i.test(String(name).trim());

/** Every path to capture, in a stable order, from the rows read below. Pure, so the self-test can run it. */
export function buildPaths({ seasons, drivers, rounds }) {
  const paths = ['/'];
  const championship = seasons
    .filter((s) => isChampionshipSeason(s.name))
    .sort((a, b) => a.number - b.number);
  for (const s of championship) {
    const classes = CLASS_NAMES.filter(
      (c) => (c !== 'Gamma' || s.gamma_enabled) && (c !== 'Delta' || s.delta_enabled),
    );
    for (const mode of ['list', 'matrix']) {
      const suffix = mode === 'list' ? '' : '&mode=matrix';
      paths.push(`/standings?season=${s.number}&class=all${suffix}`);
      for (const c of classes) paths.push(`/standings?season=${s.number}&class=${c}${suffix}`);
    }
    paths.push(`/standings?season=${s.number}&championship=teams`);
    if (s.delta_team_enabled) paths.push(`/standings?season=${s.number}&championship=teams&class=Delta`);
  }
  paths.push('/driver-stats', ...CLASS_NAMES.map((c) => `/driver-stats?class=${c}`));
  paths.push('/hall-of-fame');
  paths.push('/team-stats', '/team-stats?view=delta');
  paths.push(
    ...CLASS_NAMES.map((c) => `/champions?class=${c}`),
    '/champions?team=alpha',
    '/champions?team=delta',
  );
  const newest = [...rounds]
    .sort((a, b) => b.start_time.localeCompare(a.start_time))
    .slice(0, RESULTS_SAMPLE);
  paths.push(...newest.map((r) => `/results/${r.subsession_id}`));
  const driverIds = drivers.map((d) => d.id).sort();
  paths.push(...driverIds.map((id) => `/drivers/${id}`));
  return [...new Set(paths)];
}

async function supabaseConfig() {
  if (process.env.PUBLIC_SUPABASE_URL && process.env.PUBLIC_SUPABASE_ANON_KEY) {
    return { url: process.env.PUBLIC_SUPABASE_URL, key: process.env.PUBLIC_SUPABASE_ANON_KEY };
  }
  const text = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const value = (name) => new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`).exec(text)?.[1];
  const url = value('PUBLIC_SUPABASE_URL');
  const key = value('PUBLIC_SUPABASE_ANON_KEY');
  if (!url || !key)
    throw new Error('PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY not found in wrangler.jsonc');
  return { url, key };
}

/** Every row of a read, paged with the Range header (Supabase caps a response at 1000 rows). */
async function readAll(config, path) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${config.url}/rest/v1/${path}`, {
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        Range: `${offset}-${offset + 999}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok && res.status !== 206)
      throw new Error(`Supabase REST error ${res.status} on ${path}: ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

function selfTest() {
  const paths = buildPaths({
    seasons: [
      {
        id: 'a',
        name: 'ATC2',
        number: 2,
        gamma_enabled: false,
        delta_enabled: false,
        delta_team_enabled: false,
      },
      {
        id: 'b',
        name: 'ATC10',
        number: 10,
        gamma_enabled: true,
        delta_enabled: true,
        delta_team_enabled: true,
      },
      {
        id: 'c',
        name: 'Winter Cup',
        number: 99,
        gamma_enabled: true,
        delta_enabled: true,
        delta_team_enabled: true,
      },
    ],
    drivers: [{ id: 'd2' }, { id: 'd1' }],
    rounds: [
      { subsession_id: 1, start_time: '2026-01-01T00:00:00Z' },
      { subsession_id: 2, start_time: '2026-02-01T00:00:00Z' },
    ],
  });
  const cases = [
    ['home first', paths[0] === '/'],
    [
      'a season with only Alpha lists overall and Alpha',
      paths.includes('/standings?season=2&class=Alpha&mode=matrix') &&
        !paths.includes('/standings?season=2&class=Gamma'),
    ],
    [
      'Delta Team only where the season ran it',
      paths.includes('/standings?season=10&championship=teams&class=Delta') &&
        !paths.includes('/standings?season=2&championship=teams&class=Delta'),
    ],
    ['no exhibition season', !paths.some((p) => p.includes('season=99'))],
    ['newest round first', paths.indexOf('/results/2') < paths.indexOf('/results/1')],
    ['drivers sorted', paths.indexOf('/drivers/d1') < paths.indexOf('/drivers/d2')],
    ['no duplicates', new Set(paths).size === paths.length],
  ];
  const failed = cases.filter(([, ok]) => !ok);
  for (const [name] of failed) console.error(`self-test FAILED: ${name}`);
  if (failed.length) process.exit(1);
  console.error(`self-test: ${cases.length} passed`);
}

async function main() {
  selfTest();
  if (process.argv.includes('--self-test')) return;
  const config = await supabaseConfig();
  const [seasons, drivers, rounds] = await Promise.all([
    readAll(
      config,
      'seasons?select=id,name,number,gamma_enabled,delta_enabled,delta_team_enabled&order=number.asc',
    ),
    readAll(config, 'drivers?select=id&is_ai=eq.false&order=id.asc'),
    readAll(
      config,
      'curated_rounds?select=subsession_id,start_time&order=start_time.desc&limit=' + RESULTS_SAMPLE,
    ),
  ]);
  const paths = buildPaths({ seasons, drivers, rounds });
  process.stdout.write(paths.join('\n') + '\n');
  console.error(`snapshot-paths: ${paths.length} path(s)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
