// CPU timing of the compute paths the module split moves (functional spec W5.4; BR4.2, NFR2).
//
// Run with vite-node, so the golden loader's import.meta.glob and extensionless imports resolve the
// way they do in the tests:
//   npx vite-node scripts/compute-timing.ts [--runs 200] [--warmup 20] [--sample-ms 50] [--reps N] [--json]
//       Times each function on the ATC17 golden fixture (no network) and reports the per-call CPU
//       time from process.cpuUsage(), plus the module load time of the entry modules (their first
//       import() in this fresh process). --json prints only the JSON result, for --compare.
//   npx vite-node scripts/compute-timing.ts --load-only [--json]
//       Only the module load time (one fresh process per measurement).
//   npx vite-node scripts/compute-timing.ts --compare <before.json> <after.json>
//       Applies the threshold: each function's CPU time after is at most 110% of before plus 0.2 ms,
//       and the same for module load time. Exits 1 when any is over.
//
// The functions are found by name, not by path: the script reads every src/lib/**/*.ts and imports
// the one module that declares `export function <name>`, so it keeps working when a function moves
// between modules. To compare with another commit, copy this file into that worktree's scripts/
// folder and run it there.
//
// The results page's penalty work is applyPenaltyDisplay (margins, intervals and race times). The
// TypeScript scoring engine it replaced (applyPenaltiesToRoundResults) was deleted at the scoring
// contract step, so a --compare against a JSON result recorded before then lists that function as
// missing.
//
// Each timed run is one sample of `reps` back-to-back calls, with `reps` chosen so a sample takes at
// least --sample-ms (and at least four ticks of the process CPU clock), and the per-call time is
// the sample's CPU time divided by `reps`. 20 warm-up calls come first. The CPU clock is coarse on
// Windows (about 15.6 ms), so samples there are long and the median per-call time moves in tick
// steps; the report gives the mean as well, and --compare uses the mean when the clock is coarser
// than 1 ms and the median otherwise.

import type { PenaltyDbRow, ResultDbRow } from '../tests/lib/penaltyFixtures';
import type { Penalty } from '../src/lib/db/penalties';

declare const process: {
  argv: string[];
  platform: string;
  version: string;
  exitCode?: number;
  cpuUsage(previous?: { user: number; system: number }): { user: number; system: number };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

interface FunctionTiming {
  reps: number;
  samples: number;
  cpuMedianMs: number;
  cpuMeanMs: number;
  wallMedianMs: number;
}

interface TimingResult {
  platform: string;
  node: string;
  cpuClockMs: number;
  load: { cpuMs: number; wallMs: number; modules: string[] };
  functions: Record<string, FunctionTiming>;
}

const ENTRY_FUNCTIONS = [
  'buildSeasonOverallContext',
  'buildSeasonStandings',
  'buildOverallSeasonStandings',
  'finalizeStandings',
  'applyPenaltyDisplay',
];

const SOURCES = import.meta.glob('../src/lib/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const LOADERS = import.meta.glob('../src/lib/**/*.ts') as Record<
  string,
  () => Promise<Record<string, unknown>>
>;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const value = Number(process.argv[i + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} needs a positive number`);
  return value;
}

/** The one module under src/lib that declares `export function <name>`. */
function definingModule(name: string): string {
  const declares = new RegExp(`^export (async )?function ${name}\\b`, 'm');
  const hits = Object.keys(SOURCES).filter((p) => declares.test(SOURCES[p]));
  if (hits.length !== 1) throw new Error(`${name} is declared in ${hits.length} modules under src/lib`);
  return hits[0];
}

const cpuMs = (u: { user: number; system: number }) => (u.user + u.system) / 1000;

/** The smallest step the process CPU clock moves by, in ms. */
function cpuClockStep(): number {
  let step = Infinity;
  let prev = process.cpuUsage();
  const end = performance.now() + 200;
  while (performance.now() < end) {
    const now = process.cpuUsage();
    const d = cpuMs(now) - cpuMs(prev);
    if (d > 0) {
      step = Math.min(step, d);
      prev = now;
    }
  }
  return Number.isFinite(step) ? step : 1;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function time(
  fn: () => unknown,
  opts: { runs: number; warmup: number; sampleMs: number; reps?: number },
): FunctionTiming {
  for (let i = 0; i < opts.warmup; i++) fn();
  let reps = opts.reps ?? 1;
  if (!opts.reps) {
    for (;;) {
      const t0 = performance.now();
      for (let i = 0; i < reps; i++) fn();
      if (performance.now() - t0 >= opts.sampleMs || reps >= 1 << 20) break;
      reps *= 2;
    }
  }
  const cpu: number[] = [];
  const wall: number[] = [];
  for (let s = 0; s < opts.runs; s++) {
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    for (let i = 0; i < reps; i++) fn();
    wall.push((performance.now() - t0) / reps);
    cpu.push(cpuMs(process.cpuUsage(c0)) / reps);
  }
  return {
    reps,
    samples: opts.runs,
    cpuMedianMs: median(cpu),
    cpuMeanMs: mean(cpu),
    wallMedianMs: median(wall),
  };
}

async function loadEntryModules() {
  const paths = [...new Set(ENTRY_FUNCTIONS.map(definingModule))].sort();
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  const modules = await Promise.all(paths.map((p) => LOADERS[p]()));
  const load = { cpuMs: cpuMs(process.cpuUsage(c0)), wallMs: performance.now() - t0, modules: paths };
  const fns = new Map<string, AnyFn>();
  for (const name of ENTRY_FUNCTIONS) {
    const mod = modules[paths.indexOf(definingModule(name))];
    if (typeof mod[name] !== 'function')
      throw new Error(`${name} is not exported by ${definingModule(name)}`);
    fns.set(name, mod[name] as AnyFn);
  }
  return { load, fns };
}

/** The work each timed function does on the golden fixture, built once. */
async function workloads(fns: Map<string, AnyFn>): Promise<[string, () => unknown][]> {
  const golden = await import('../tests/golden/atc17');
  const fixtures = await import('../tests/lib/penaltyFixtures');
  const { inputs, season, exhibitionIds } = golden;
  const ctx = golden.buildContext();

  // finalizeStandings on an overall accumulator built from the captured scores.
  const accum = new Map<string, Record<string, unknown>>();
  for (const s of inputs.overallScores) {
    if (exhibitionIds.has(s.subsession_id)) continue;
    let a = accum.get(s.driver_id) as
      | { starts: number; subsessionIds: Set<number>; roundPoints: Map<number, number>; [k: string]: unknown }
      | undefined;
    if (!a) {
      a = {
        starts: 0,
        subsessionIds: new Set<number>(),
        poleSubsessionIds: new Set<number>(),
        wins: 0,
        podiums: 0,
        top5s: 0,
        top10s: 0,
        lapsLed: 0,
        laps: 0,
        roundPoints: new Map<number, number>(),
        roundStats: new Map(),
      };
      accum.set(s.driver_id, a);
    }
    if (!a.subsessionIds.has(s.subsession_id)) {
      a.starts++;
      a.subsessionIds.add(s.subsession_id);
    }
    const points = s.finish_points + s.finesse_bonus + s.pole_bonus + s.aggression_bonus + s.points_deduction;
    a.roundPoints.set(s.subsession_id, (a.roundPoints.get(s.subsession_id) ?? 0) + points);
    const p = s.scored_position;
    if (p !== null) {
      for (const [key, limit] of [
        ['wins', 1],
        ['podiums', 3],
        ['top5s', 5],
        ['top10s', 10],
      ] as const) {
        if (p <= limit) a[key] = (a[key] as number) + 1;
      }
    }
  }
  const driverById = new Map(inputs.drivers.map((d) => [d.id, d]));
  const pool = golden.poolFor(null, ctx);

  // applyPenaltiesToRoundResults on every captured round that has penalties.
  const driverByCust = new Map(inputs.drivers.map((d) => [d.iracing_cust_id, d.id]));
  const key = (sid: number, race: number, driver: string | undefined) => `${sid}:${race}:${driver}`;
  const raw = new Map(
    inputs.rawResults.map((r) => [key(r.subsession_id, r.race_number, driverByCust.get(r.cust_id)), r]),
  );
  const laps = new Map(
    inputs.lapStats.map((r) => [key(r.subsession_id, r.race_number, driverByCust.get(r.cust_id)), r]),
  );
  const classScores = new Map(
    Object.values(inputs.scoresByClass)
      .flat()
      .map((r) => [key(r.subsession_id, r.race_number, r.driver_id), r]),
  );
  const rowsBySubsession = new Map<number, ResultDbRow[]>();
  for (const s of inputs.overallScores) {
    const k = key(s.subsession_id, s.race_number, s.driver_id);
    const r = raw.get(k);
    const c = classScores.get(k);
    const row: ResultDbRow = {
      subsession_id: s.subsession_id,
      race_number: s.race_number,
      driver_id: s.driver_id,
      class_id: s.class_id,
      scored_position: s.scored_position,
      finish_points: s.finish_points,
      class_points: c?.class_points ?? 0,
      finesse_bonus: s.finesse_bonus,
      pole_bonus: s.pole_bonus,
      aggression_bonus: s.aggression_bonus,
      lap_led_bonus: c?.lap_led_bonus ?? 0,
      fewest_incidents_bonus: c?.fewest_incidents_bonus ?? 0,
      fastest_lap_bonus: c?.fastest_lap_bonus ?? 0,
      sprint_sweep_bonus: c?.sprint_sweep_bonus ?? 0,
      points_deduction: s.points_deduction,
      classified: s.classified,
      dsq: s.dsq,
      finish_position: r?.finish_position ?? s.scored_position ?? 999,
      adjusted_position: r?.adjusted_position ?? null,
      interval_ten_thousandths: r?.interval_ten_thousandths ?? null,
      laps_complete: r?.laps_complete ?? null,
      average_lap_ten_thousandths: laps.get(k)?.average_lap_ten_thousandths ?? null,
    };
    if (!rowsBySubsession.has(s.subsession_id)) rowsBySubsession.set(s.subsession_id, []);
    rowsBySubsession.get(s.subsession_id)!.push(row);
  }
  const penalties = fixtures.toPenalties(inputs.penalties as unknown as PenaltyDbRow[]);
  const rounds = [...rowsBySubsession]
    .map(([subsessionId, rows]) => ({
      // The display reads only the scoring fields every Penalty has.
      ...fixtures.toRoundResults(rows),
      penalties: penalties.filter((p) => p.subsession_id === subsessionId) as unknown as Penalty[],
    }))
    .filter((r) => r.penalties.length > 0);
  if (rounds.length === 0) throw new Error('the golden fixture has no round with penalties');

  const finalize = fns.get('finalizeStandings')!;
  const applyPenaltyDisplay = fns.get('applyPenaltyDisplay')!;
  return [
    ['buildSeasonOverallContext', () => golden.buildContext()],
    ...inputs.classes.map(
      (c) =>
        [`buildSeasonStandings (${c.name})`, () => golden.standingsFor(c.id, ctx)] as [string, () => unknown],
    ),
    ['buildOverallSeasonStandings', () => golden.standingsFor(null, ctx)],
    ['finalizeStandings (overall)', () => finalize(accum, driverById, season, pool, null, true, 2)],
    [
      `applyPenaltyDisplay (${rounds.length} rounds)`,
      () => {
        for (const r of rounds) applyPenaltyDisplay(r);
      },
    ],
  ];
}

const fmt = (ms: number) => ms.toFixed(3).padStart(10);

function printResult(result: TimingResult) {
  console.log(
    `compute-timing on ${result.platform}, Node ${result.node}; CPU clock step ${result.cpuClockMs.toFixed(3)} ms`,
  );
  console.log(`module load (first import of ${result.load.modules.length} entry modules):`);
  console.log(`  cpu ${result.load.cpuMs.toFixed(1)} ms, wall ${result.load.wallMs.toFixed(1)} ms`);
  for (const m of result.load.modules) console.log(`    ${m}`);
  if (Object.keys(result.functions).length === 0) return;
  console.log(
    `${'function'.padEnd(46)}${'cpu median'.padStart(12)}${'cpu mean'.padStart(12)}${'wall median'.padStart(12)}  reps x runs`,
  );
  for (const [name, t] of Object.entries(result.functions)) {
    console.log(
      `${name.padEnd(46)}${fmt(t.cpuMedianMs)} ms${fmt(t.cpuMeanMs)} ms${fmt(t.wallMedianMs)} ms  ${t.reps} x ${t.samples}`,
    );
  }
}

async function readJson(file: string): Promise<TimingResult> {
  // Through a variable so the type check doesn't look for Node's type definitions.
  const fsModule = 'node:fs';
  const fs = await import(/* @vite-ignore */ fsModule);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as TimingResult;
}

async function compare(beforeFile: string, afterFile: string): Promise<number> {
  const before = await readJson(beforeFile);
  const after = await readJson(afterFile);
  const coarse = Math.max(before.cpuClockMs, after.cpuClockMs) > 1;
  const pick = (t: FunctionTiming) => (coarse ? t.cpuMeanMs : t.cpuMedianMs);
  console.log(
    `threshold: after <= 110% of before + 0.2 ms, on the CPU ${coarse ? 'mean (coarse clock)' : 'median'}`,
  );
  let failures = 0;
  const row = (name: string, b: number, a: number) => {
    const limit = b * 1.1 + 0.2;
    const ok = a <= limit;
    if (!ok) failures++;
    console.log(
      `  ${ok ? 'ok  ' : 'OVER'} ${name.padEnd(46)} before ${fmt(b)} ms  after ${fmt(a)} ms  limit ${fmt(limit)} ms`,
    );
  };
  row('module load', before.load.cpuMs, after.load.cpuMs);
  for (const [name, b] of Object.entries(before.functions)) {
    const a = after.functions[name];
    if (!a) {
      failures++;
      console.log(`  MISSING ${name} has no timing in ${afterFile}`);
      continue;
    }
    row(name, pick(b), pick(a));
  }
  console.log(
    failures === 0
      ? 'compute-timing: within the threshold'
      : `compute-timing: ${failures} over the threshold`,
  );
  return failures === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const ci = argv.indexOf('--compare');
  if (ci >= 0) {
    const [beforeFile, afterFile] = argv.slice(ci + 1, ci + 3);
    if (!beforeFile || !afterFile) throw new Error('--compare needs <before.json> <after.json>');
    return compare(beforeFile, afterFile);
  }
  const json = argv.includes('--json');
  const { load, fns } = await loadEntryModules();
  const result: TimingResult = {
    platform: process.platform,
    node: process.version,
    cpuClockMs: cpuClockStep(),
    load,
    functions: {},
  };
  if (!argv.includes('--load-only')) {
    const opts = {
      runs: arg('--runs', 200),
      warmup: arg('--warmup', 20),
      sampleMs: Math.max(arg('--sample-ms', 50), result.cpuClockMs * 4),
      reps: argv.includes('--reps') ? arg('--reps', 1) : undefined,
    };
    for (const [name, fn] of await workloads(fns)) result.functions[name] = time(fn, opts);
  }
  if (json) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`compute-timing: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  },
);

export {};
