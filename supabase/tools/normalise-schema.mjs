#!/usr/bin/env node
// Schema normaliser for comparing two dumps made with the baseline's two-part method (production
// against a throwaway database built from the migrations). It keeps what defines the schema and
// drops what differs between two equal databases: comments, `SET`/`set_config` preamble, psql
// meta-commands (pg_dump 17.6 adds random `\restrict` keys) and `OWNER TO` statements (the
// throwaway database's owners are not production's). Whitespace runs collapse to one space.
//
//   node supabase/tools/normalise-schema.mjs [--sort] <file>   prints one statement per line
//   node supabase/tools/normalise-schema.mjs --diff <a> <b>    exits 1 and lists differences
//
// The diff compares statements as a multiset: dump order follows object names and dependencies,
// not meaning, and the platform part comes from catalog queries whose order is ours to choose.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Splits SQL into statements, dropping comments and psql meta-command lines. */
export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  let atLineStart = true;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (atLineStart && ch === '\\') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      // Block comments nest in Postgres.
      let depth = 0;
      do {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      } while (depth > 0 && i < sql.length);
      current += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      // Quoted literal or identifier; a doubled quote is an escaped quote.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch && sql[j + 1] === ch) j += 2;
        else if (sql[j] === ch) break;
        else j++;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      atLineStart = false;
      continue;
    }
    if (ch === '$') {
      // Dollar quoting ($$ or $tag$), used for function bodies: copy the body verbatim.
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        const stop = end === -1 ? sql.length : end + tag[0].length;
        current += sql.slice(i, stop);
        i = stop;
        atLineStart = false;
        continue;
      }
    }
    if (ch === ';') {
      statements.push(current);
      current = '';
      i++;
      atLineStart = false;
      continue;
    }
    current += ch;
    atLineStart = ch === '\n';
    i++;
  }
  statements.push(current);
  return statements;
}

const PREAMBLE = /^(?:SET\s|SELECT\s+pg_catalog\.set_config\s*\()/i;
const OWNER_TO = /^ALTER\s+.+\sOWNER\s+TO\s+\S+$/is;

/** Returns the normalised statements of a dump, each ending in `;`. */
export function normalise(sql, { sort = false } = {}) {
  const statements = splitStatements(sql)
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter((statement) => statement !== '' && !PREAMBLE.test(statement) && !OWNER_TO.test(statement))
    .map((statement) => `${statement};`);
  return sort ? statements.sort() : statements;
}

/** Statements only in `a` (removed) and only in `b` (added), comparing as multisets. */
export function diffSchemas(aSql, bSql) {
  const counts = new Map();
  for (const statement of normalise(aSql)) counts.set(statement, (counts.get(statement) ?? 0) + 1);
  const added = [];
  for (const statement of normalise(bSql)) {
    const left = counts.get(statement) ?? 0;
    if (left > 0) counts.set(statement, left - 1);
    else added.push(statement);
  }
  const removed = [];
  for (const [statement, left] of counts) for (let n = 0; n < left; n++) removed.push(statement);
  return { removed: removed.sort(), added: added.sort() };
}

function readOrExit(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    console.error(`normalise-schema: cannot read ${path}: ${error.message}`);
    process.exit(2);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--diff' && args.length === 3) {
    const { removed, added } = diffSchemas(readOrExit(args[1]), readOrExit(args[2]));
    if (removed.length === 0 && added.length === 0) {
      console.log('No schema differences.');
      return;
    }
    for (const statement of removed) console.log(`- ${statement}`);
    for (const statement of added) console.log(`+ ${statement}`);
    console.log(`${removed.length} only in ${args[1]}, ${added.length} only in ${args[2]}.`);
    process.exit(1);
  }
  const sort = args[0] === '--sort';
  const files = sort ? args.slice(1) : args;
  if (files.length !== 1) {
    console.error('usage: normalise-schema.mjs [--sort] <file> | --diff <a> <b>');
    process.exit(2);
  }
  for (const statement of normalise(readOrExit(files[0]), { sort })) console.log(statement);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
