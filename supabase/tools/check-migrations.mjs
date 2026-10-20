#!/usr/bin/env node
// Migration rule checker (BR1.1–BR1.6 in the migration-history design), run by the
// `migrations-static` job and by hand:
//
//   node supabase/tools/check-migrations.mjs --base origin/main --head HEAD
//
// It compares two git refs, prints one message per violation (naming the file), then prints
// `cutover=true|false` and `new_migrations=<file,file,...>` so workflows can read them, and exits
// 1 when any rule is broken. Dependency-free on purpose: it runs before `npm ci` in CI.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ACTIVE_DIR = 'supabase/migrations/';
const ARCHIVE_DIR = 'supabase/migrations/archive/';
const DATA_FIX_DIR = 'supabase/data-fixes/';
const DOWN_DIR = 'supabase/down/';
const DATA_FIX_README = `${DATA_FIX_DIR}README.md`;

const MIGRATION_NAME = /^(\d{14})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const DATA_FIX_NAME = /^\d{8}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const BASELINE_NAME = /^\d{14}_baseline_(?:schema|platform)\.sql$/;
// Any leading digits count as a version, so the legacy 0001…/00891… files can be compared too.
const ANY_VERSION = /^(\d+)_/;

function git(cwd, args) {
  // stderr is captured so a failure surfaces as the thrown error, not as stray console output.
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function basename(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

// Active migrations sit directly in supabase/migrations/; anything deeper (the archive) is not run.
function isActive(path) {
  return path.startsWith(ACTIVE_DIR) && !path.slice(ACTIVE_DIR.length).includes('/');
}

function isArchive(path) {
  return path.startsWith(ARCHIVE_DIR);
}

function isDataFix(path) {
  return (
    path.startsWith(DATA_FIX_DIR) && path.endsWith('.sql') && !path.slice(DATA_FIX_DIR.length).includes('/')
  );
}

function versionOf(file) {
  const match = ANY_VERSION.exec(basename(file));
  return match ? BigInt(match[1]) : null;
}

function listFiles(cwd, ref) {
  const out = git(cwd, ['ls-tree', '-r', '-z', '--name-only', ref, '--', 'supabase/']);
  return new Set(out.split('\0').filter(Boolean));
}

function readFile(cwd, ref, files, path) {
  return files.has(path) ? git(cwd, ['show', `${ref}:${path}`]) : '';
}

// Parses `git diff --name-status -z` output. Renames are found at 50% similarity so a renamed-and-
// edited migration is reported as such (with its score) instead of as an unrelated delete and add.
function changedFiles(cwd, base, head) {
  const out = git(cwd, [
    'diff',
    '--no-ext-diff',
    '--name-status',
    '-z',
    '--find-renames=50%',
    base,
    head,
    '--',
    'supabase/',
  ]);
  const fields = out.split('\0').filter((field) => field !== '');
  const changes = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      changes.push({ kind, score: Number(status.slice(1)), from: fields[i++], to: fields[i++] });
    } else {
      changes.push({ kind, path: fields[i++] });
    }
  }
  return changes;
}

/**
 * Checks the change from `base` to `head` in the repository at `cwd`.
 * Returns { violations: [{ file, message }], cutover, newMigrations }.
 */
export function checkMigrations({ base, head = 'HEAD', cwd = process.cwd() }) {
  const baseFiles = listFiles(cwd, base);
  const headFiles = listFiles(cwd, head);
  const baseHasArchive = [...baseFiles].some(isArchive);
  const headHasArchive = [...headFiles].some(isArchive);
  // The cutover PR is the one that creates the archive. Once the archive is on main this can never
  // match again, so the relaxed rename rules below apply exactly once.
  const cutover = !baseHasArchive && headHasArchive;

  const violations = [];
  const fail = (file, message) => violations.push({ file, message });

  const baseVersions = [...baseFiles]
    .filter((f) => isActive(f) && f.endsWith('.sql'))
    .map(versionOf)
    .filter((v) => v !== null);
  const newestBase = baseVersions.reduce((max, v) => (v > max ? v : max), -1n);

  const readme = readFile(cwd, head, headFiles, DATA_FIX_README);
  const newMigrations = [];

  const checkAddedActive = (path) => {
    const name = basename(path);
    const match = MIGRATION_NAME.exec(name);
    if (!match) {
      fail(path, 'migration name must be YYYYMMDDHHMMSS_lowercase_name.sql (BR1.1)');
      return;
    }
    const down = `${DOWN_DIR}${name.replace(/\.sql$/, '.down.sql')}`;
    if (!headFiles.has(down)) fail(path, `missing down script ${down} (BR1.2)`);
    const exemptBaseline = cutover && BASELINE_NAME.test(name);
    if (!exemptBaseline && BigInt(match[1]) <= newestBase) {
      fail(path, `version ${match[1]} is not later than the newest migration on the base branch (BR1.4)`);
    }
    newMigrations.push(name);
  };

  const checkAddedArchive = (path) => {
    if (!cutover) fail(path, 'files in supabase/migrations/archive/ are frozen after the cutover (BR1.3)');
  };

  const checkAddedDataFix = (path, viaCutoverMove) => {
    const name = basename(path);
    if (DATA_FIX_NAME.test(name)) return;
    // The legacy fixes keep their old names, but only when they arrive by the cutover move and the
    // data-fixes README lists them as exempt.
    if (viaCutoverMove && readme.includes(name)) return;
    fail(
      path,
      'data-fix name must be YYYYMMDD_lowercase_name.sql (legacy names must be listed in README.md)',
    );
  };

  const checkAdded = (path) => {
    if (isArchive(path)) checkAddedArchive(path);
    else if (isActive(path)) checkAddedActive(path);
    else if (isDataFix(path)) checkAddedDataFix(path, false);
  };

  const checkRemoved = (path) => {
    if (isArchive(path) && baseHasArchive) {
      fail(path, 'files in supabase/migrations/archive/ are never deleted or moved (BR1.3)');
    } else if (isActive(path)) {
      fail(
        path,
        'an active migration on the base branch must not be deleted; undo it with a new migration (BR1.6)',
      );
    }
  };

  for (const change of changedFiles(cwd, base, head)) {
    if (change.kind === 'A') {
      checkAdded(change.path);
    } else if (change.kind === 'D') {
      checkRemoved(change.path);
    } else if (change.kind === 'M' || change.kind === 'T') {
      if (isArchive(change.path) && baseHasArchive) {
        fail(change.path, 'files in supabase/migrations/archive/ are never edited (BR1.3)');
      } else if (isActive(change.path)) {
        fail(
          change.path,
          'an active migration on the base branch must not be edited; add a new migration (BR1.6)',
        );
      }
    } else if (change.kind === 'R' || change.kind === 'C') {
      const { from, to, score } = change;
      const intoCutoverFolder = isArchive(to) || isDataFix(to);
      if (cutover && isActive(from) && intoCutoverFolder && change.kind === 'R') {
        if (score === 100) {
          if (isDataFix(to)) checkAddedDataFix(to, true);
        } else {
          fail(to, `moved from ${from} with edits (${score}% similar); cutover moves must be byte-identical`);
        }
        continue;
      }
      // Anything else is judged as what it really is: the old path removed and the new one added.
      if (change.kind === 'R') checkRemoved(from);
      checkAdded(to);
    }
  }

  const seen = new Map();
  for (const name of newMigrations) {
    const version = MIGRATION_NAME.exec(name)[1];
    if (seen.has(version))
      fail(`${ACTIVE_DIR}${name}`, `version ${version} is also used by ${seen.get(version)}`);
    seen.set(version, name);
  }

  newMigrations.sort();
  return { violations, cutover, newMigrations };
}

function parseArgs(argv) {
  const args = { base: null, head: 'HEAD' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') args.base = argv[++i];
    else if (argv[i] === '--head') args.head = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.base) throw new Error('usage: check-migrations.mjs --base <ref> [--head <ref>]');
  return args;
}

function main() {
  let result;
  try {
    result = checkMigrations(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`check-migrations: ${error.message}`);
    process.exit(2);
  }
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  for (const { file, message } of result.violations) {
    // In Actions the same line becomes an annotation on the file in the PR.
    console.error(inActions ? `::error file=${file}::${message}` : `${file}: ${message}`);
  }
  console.log(`cutover=${result.cutover}`);
  console.log(`new_migrations=${result.newMigrations.join(',')}`);
  if (result.violations.length > 0) {
    console.error(`${result.violations.length} migration rule violation(s).`);
    process.exit(1);
  }
  console.log('Migration rules: all passed.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
