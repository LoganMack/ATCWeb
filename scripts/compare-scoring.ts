// The scoring comparison (unit scoring-ownership, W5; FR5.4, BR6.1-BR6.3).
//
// Lists every difference between what the site shows today and what database-owned scoring
// (race_score_results_public) will show, per round, race, driver, audience and field, each with
// the causes that explain it, so the owner can decide each cause once before the switch.
//
// Run by the owner, with the service-role key set only in their own shell (it must read unposted
// penalties and call score_round_preview). Read-only: it never writes to the database.
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx vite-node scripts/compare-scoring.ts \
//     [--out <dir>] [--rounds <subsession_id,...>] [--concurrency <n>]
// PUBLIC_SUPABASE_URL is accepted in place of SUPABASE_URL. Writes report.md and decisions.json
// to --out (default: the unit's comparison folder in the AI-DLC record).

import type { SupabaseEnv } from '../src/lib/db/client';
import { renderDecisions, renderReport, type DiffLine } from './lib/scoringAttribution';
import {
  compareRound,
  listScoredRounds,
  listScoringIssues,
  loadSharedData,
  mapLimit,
  type RoundComparison,
} from './lib/scoringComparison';

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
};

interface FsModule {
  mkdirSync(path: string, options: { recursive: boolean }): void;
  writeFileSync(path: string, data: string, encoding: 'utf8'): void;
}

const DEFAULT_OUT = 'aidlc/spaces/default/intents/261019-tech-debt-fixes/construction/scoring-ownership/comparison';

const NOTES = [
  'Today is what the site shows with the anon key, the same for admins and everyone else: position, finish points, ' +
    'class points, each bonus and the deduction come from the results page (Overall view), class position and ' +
    'class_view_finish_points from its Per Class view, overall_total from the overall standings, and class_total ' +
    'from the class standings.',
  'New is race_score_results_public for that audience: the final set for admins and posted rounds, otherwise the raw ' +
    'set with no deduction. A `row` line means the row exists on one side only.',
];

interface Options {
  out: string;
  rounds: number[] | null;
  concurrency: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { out: DEFAULT_OUT, rounds: null, concurrency: 3 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--out' && value) {
      opts.out = value;
      i++;
    } else if (arg === '--rounds' && value) {
      const ids = value.split(',').map((s) => Number(s.trim()));
      if (ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new Error(`--rounds needs subsession ids, got "${value}"`);
      opts.rounds = ids;
      i++;
    } else if (arg === '--concurrency' && value) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 8) throw new Error('--concurrency must be 1 to 8');
      opts.concurrency = n;
      i++;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

/** The service-role env from the shell. Refuses to run without both values; nothing is read from files. */
function envFromShell(): SupabaseEnv {
  const url = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Set SUPABASE_URL (or PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY in this shell. ' +
        'The comparison needs the service role to read unposted penalties and call score_round_preview.',
    );
  }
  return { url: url.replace(/\/+$/, ''), anonKey: key };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const env = envFromShell();
  const fsModule = 'node:fs';
  const fs = (await import(/* @vite-ignore */ fsModule)) as FsModule;

  const [shared, scored, issues] = await Promise.all([
    loadSharedData(env),
    listScoredRounds(env),
    listScoringIssues(env),
  ]);
  const rounds = opts.rounds ?? scored;
  const notScored = opts.rounds ? opts.rounds.filter((id) => !scored.includes(id)) : [];
  const skipped = [
    ...issues.filter((i) => opts.rounds === null || opts.rounds.includes(i.subsessionId)),
    ...notScored
      .filter((id) => !issues.some((i) => i.subsessionId === id))
      .map((id) => ({ subsessionId: id, reason: 'no rows in race_score_results' })),
  ];
  const toCompare = rounds.filter((id) => scored.includes(id));
  console.log(`Comparing ${toCompare.length} rounds (${skipped.length} skipped)...`);

  const failures: { subsessionId: number; reason: string }[] = [];
  let done = 0;
  const results = await mapLimit(toCompare, opts.concurrency, async (id): Promise<RoundComparison | null> => {
    try {
      const r = await compareRound(env, shared, id);
      done++;
      if (r.lines.length > 0 || done % 25 === 0) {
        console.log(`  [${done}/${toCompare.length}] ${id}: ${r.lines.length} lines, ${r.previewCalls} previews`);
      }
      return r;
    } catch (err) {
      done++;
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`  [${done}/${toCompare.length}] ${id} FAILED: ${reason}`);
      failures.push({ subsessionId: id, reason: `comparison failed: ${reason}` });
      return null;
    }
  });

  const compared = results.filter((r): r is RoundComparison => r !== null);
  const lines: DiffLine[] = compared.flatMap((r) => r.lines);
  const generatedAt = new Date().toISOString();
  const report = renderReport(lines, {
    generatedAt,
    roundsCompared: compared.length,
    roundsWithDifferences: compared.filter((r) => r.lines.length > 0).length,
    roundsSkipped: [...skipped, ...failures].sort((a, b) => a.subsessionId - b.subsessionId),
    notes: NOTES,
  });
  const decisions = renderDecisions(lines, generatedAt);

  fs.mkdirSync(opts.out, { recursive: true });
  fs.writeFileSync(`${opts.out}/report.md`, report, 'utf8');
  fs.writeFileSync(`${opts.out}/decisions.json`, `${JSON.stringify(decisions, null, 2)}\n`, 'utf8');

  const unexplained = lines.filter((l) => l.causes.length === 0).length;
  console.log(`Wrote ${opts.out}/report.md and decisions.json: ${lines.length} lines, ${unexplained} unexplained.`);
  for (const c of decisions.causes) console.log(`  ${c.cause}: ${c.lines} lines in ${c.rounds.length} rounds`);
  if (failures.length > 0) {
    console.error(`${failures.length} rounds failed; the report is incomplete.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
