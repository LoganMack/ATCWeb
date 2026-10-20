// Tests for check-migrations.mjs. Each case builds a throwaway git repository in a temp folder:
// a base commit, then the PR's changes as a head commit. No network is used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { checkMigrations } from './check-migrations.mjs';

const repos = [];

// Several lines, so git can detect a renamed-and-edited copy as a rename with a similarity score.
const DRIVERS = [
  'create table public.drivers (',
  '  id int primary key,',
  '  name text,',
  '  iracing_id int,',
  '  signup_date date,',
  '  country text',
  ');',
  'alter table public.drivers enable row level security;',
  '',
].join('\n');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'check-migrations-'));
  repos.push(cwd);
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'config', 'core.autocrlf', 'false');
  return cwd;
}

function write(cwd, path, content) {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), content);
}

function move(cwd, from, to) {
  mkdirSync(dirname(join(cwd, to)), { recursive: true });
  renameSync(join(cwd, from), join(cwd, to));
}

function commit(cwd, message) {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD').trim();
}

// A post-cutover base: two baselines with their down notes, and an archive.
function postCutoverRepo() {
  const cwd = makeRepo();
  write(
    cwd,
    'supabase/migrations/20261020100000_baseline_schema.sql',
    'create table public.rounds (id int);\n',
  );
  write(cwd, 'supabase/migrations/20261020100001_baseline_platform.sql', 'select 1;\n');
  write(cwd, 'supabase/down/20261020100000_baseline_schema.down.sql', '-- restore a backup\n');
  write(cwd, 'supabase/down/20261020100001_baseline_platform.down.sql', '-- restore a backup\n');
  write(cwd, 'supabase/migrations/archive/0001_init.sql', 'create table public.rounds (id int);\n');
  return { cwd, base: commit(cwd, 'base') };
}

// A pre-cutover base: legacy numbered migrations, including a data fix, and no archive.
function preCutoverRepo() {
  const cwd = makeRepo();
  write(cwd, 'supabase/migrations/0001_init.sql', 'create table public.rounds (id int, season text);\n');
  write(cwd, 'supabase/migrations/0002_drivers.sql', DRIVERS);
  write(cwd, 'supabase/migrations/00891_delete_bad_round.sql', 'delete from public.rounds where id = 7;\n');
  return { cwd, base: commit(cwd, 'base') };
}

afterEach(() => {
  while (repos.length) rmSync(repos.pop(), { recursive: true, force: true });
});

describe('check-migrations', () => {
  it('passes a valid timestamped migration with its down script', () => {
    const { cwd, base } = postCutoverRepo();
    write(
      cwd,
      'supabase/migrations/20261101120000_add_round_notes.sql',
      'alter table public.rounds add notes text;\n',
    );
    write(
      cwd,
      'supabase/down/20261101120000_add_round_notes.down.sql',
      'alter table public.rounds drop notes;\n',
    );
    const head = commit(cwd, 'head');

    const result = checkMigrations({ base, head, cwd });
    assert.deepEqual(result.violations, []);
    assert.equal(result.cutover, false);
    assert.deepEqual(result.newMigrations, ['20261101120000_add_round_notes.sql']);
  });

  it('fails a migration with a bad name', () => {
    const { cwd, base } = postCutoverRepo();
    write(cwd, 'supabase/migrations/0117_Add-Notes.sql', 'select 1;\n');
    write(cwd, 'supabase/down/0117_Add-Notes.down.sql', 'select 1;\n');
    const head = commit(cwd, 'head');

    const { violations } = checkMigrations({ base, head, cwd });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, 'supabase/migrations/0117_Add-Notes.sql');
    assert.match(violations[0].message, /BR1\.1/);
  });

  it('fails a migration without a down script', () => {
    const { cwd, base } = postCutoverRepo();
    write(
      cwd,
      'supabase/migrations/20261101120000_add_round_notes.sql',
      'alter table public.rounds add notes text;\n',
    );
    const head = commit(cwd, 'head');

    const { violations } = checkMigrations({ base, head, cwd });
    assert.equal(violations.length, 1);
    assert.match(
      violations[0].message,
      /missing down script supabase\/down\/20261101120000_add_round_notes\.down\.sql/,
    );
  });

  it('fails an edit to an active migration that exists on base', () => {
    const { cwd, base } = postCutoverRepo();
    write(
      cwd,
      'supabase/migrations/20261020100000_baseline_schema.sql',
      'create table public.rounds (id bigint);\n',
    );
    const head = commit(cwd, 'head');

    const { violations } = checkMigrations({ base, head, cwd });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, 'supabase/migrations/20261020100000_baseline_schema.sql');
    assert.match(violations[0].message, /must not be edited.*BR1\.6/);
  });

  it('allows editing a merged migration only when production never applied it', () => {
    const { cwd, base } = postCutoverRepo();
    write(cwd, 'supabase/migrations/20261020100001_baseline_platform.sql', 'select 2;\n');
    const head = commit(cwd, 'head');

    // Production lists only the schema baseline, so the platform file never ran: edit allowed.
    const unapplied = checkMigrations({ base, head, cwd, appliedVersions: new Set(['20261020100000']) });
    assert.deepEqual(unapplied.violations, []);

    // Once production lists it, the same edit is refused.
    const applied = checkMigrations({
      base,
      head,
      cwd,
      appliedVersions: new Set(['20261020100000', '20261020100001']),
    });
    assert.equal(applied.violations.length, 1);
    assert.match(applied.violations[0].message, /must not be edited.*BR1\.6/);
  });

  it('fails deleting an active migration', () => {
    const { cwd, base } = postCutoverRepo();
    rmSync(join(cwd, 'supabase/migrations/20261020100001_baseline_platform.sql'));
    const head = commit(cwd, 'head');

    const { violations } = checkMigrations({ base, head, cwd });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, 'supabase/migrations/20261020100001_baseline_platform.sql');
    assert.match(violations[0].message, /must not be deleted.*BR1\.6/);
  });

  it('fails an edit to an archive file after the cutover', () => {
    const { cwd, base } = postCutoverRepo();
    write(
      cwd,
      'supabase/migrations/archive/0001_init.sql',
      'create table public.rounds (id int, extra text);\n',
    );
    const head = commit(cwd, 'head');

    const { violations } = checkMigrations({ base, head, cwd });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, 'supabase/migrations/archive/0001_init.sql');
    assert.match(violations[0].message, /BR1\.3/);
  });

  it('passes the cutover PR (100% renames plus two baselines) and reports cutover=true', () => {
    const { cwd, base } = preCutoverRepo();
    move(cwd, 'supabase/migrations/0001_init.sql', 'supabase/migrations/archive/0001_init.sql');
    move(cwd, 'supabase/migrations/0002_drivers.sql', 'supabase/migrations/archive/0002_drivers.sql');
    move(
      cwd,
      'supabase/migrations/00891_delete_bad_round.sql',
      'supabase/data-fixes/00891_delete_bad_round.sql',
    );
    write(cwd, 'supabase/migrations/archive/README.md', 'Old migrations, never run again.\n');
    write(cwd, 'supabase/data-fixes/README.md', 'Legacy names (exempt): `00891_delete_bad_round.sql`\n');
    write(
      cwd,
      'supabase/migrations/20261020100000_baseline_schema.sql',
      'create table public.rounds (id int);\n',
    );
    write(cwd, 'supabase/migrations/20261020100001_baseline_platform.sql', 'select 1;\n');
    write(cwd, 'supabase/down/20261020100000_baseline_schema.down.sql', '-- restore a backup\n');
    write(cwd, 'supabase/down/20261020100001_baseline_platform.down.sql', '-- restore a backup\n');
    const head = commit(cwd, 'head');

    const result = checkMigrations({ base, head, cwd });
    assert.deepEqual(result.violations, []);
    assert.equal(result.cutover, true);
    assert.deepEqual(result.newMigrations, [
      '20261020100000_baseline_schema.sql',
      '20261020100001_baseline_platform.sql',
    ]);
  });

  it('fails a renamed-and-edited file in the cutover PR', () => {
    const { cwd, base } = preCutoverRepo();
    move(cwd, 'supabase/migrations/0001_init.sql', 'supabase/migrations/archive/0001_init.sql');
    move(cwd, 'supabase/migrations/0002_drivers.sql', 'supabase/migrations/archive/0002_drivers.sql');
    // Same file, one column changed on the way into the archive.
    write(
      cwd,
      'supabase/migrations/archive/0002_drivers.sql',
      DRIVERS.replace('  name text,', '  full_name text,'),
    );
    move(
      cwd,
      'supabase/migrations/00891_delete_bad_round.sql',
      'supabase/data-fixes/00891_delete_bad_round.sql',
    );
    write(cwd, 'supabase/data-fixes/README.md', 'Legacy names (exempt): `00891_delete_bad_round.sql`\n');
    const head = commit(cwd, 'head');

    const result = checkMigrations({ base, head, cwd });
    assert.equal(result.cutover, true);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].file, 'supabase/migrations/archive/0002_drivers.sql');
    assert.match(
      result.violations[0].message,
      /moved from supabase\/migrations\/0002_drivers\.sql with edits/,
    );
  });
});
