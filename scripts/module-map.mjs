// Module maps for the module split (functional spec W1, W4; Delivery item 3).
//
// A module map says where each top-level declaration of a file that is being split now lives.
// scripts/move-check.mjs and scripts/rewrite-imports.mjs both read it, so one map drives the
// proof and the importer rewrite for each PR.
//
// Maps live in scripts/module-maps/<name>.json, one per original file, and are found by their
// "original" field. They are copied from that file's section of the module-split symbol map;
// `--map <symbol-map.md>` reads such a section directly instead (only the declaration table, so
// no rewrites or wrappers). The JSON fields are documented in scripts/move-check.mjs.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const MAP_DIR = 'scripts/module-maps';

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** Fills in the optional fields so callers never have to check for them. */
export function normaliseMap(raw, source) {
  if (!raw || typeof raw !== 'object') throw new Error(`${source}: not a module map`);
  if (typeof raw.original !== 'string') throw new Error(`${source}: "original" is missing`);
  if (!raw.modules || typeof raw.modules !== 'object') throw new Error(`${source}: "modules" is missing`);
  const modules = raw.modules;
  return {
    source,
    original: toPosix(raw.original),
    originalDeleted: raw.originalDeleted ?? true,
    folders: raw.folders ?? [...new Set(Object.values(modules).map((m) => path.posix.dirname(m)))],
    modules,
    newDeclarations: raw.newDeclarations ?? [],
    rewrites: raw.rewrites ?? [],
    wrappers: raw.wrappers ?? [],
    listedRemovals: raw.listedRemovals ?? [],
    listedAdditions: raw.listedAdditions ?? [],
  };
}

/**
 * Reads the declaration table under "## `<original>`" in a symbol-map.md: rows of
 * | line | `Symbol` | kind | exported | `module` |.
 */
export function parseSymbolMapMarkdown(text, original) {
  const lines = text.split(/\r?\n/);
  const heading = lines.findIndex((l) => l.trim() === `## \`${original}\``);
  if (heading < 0) throw new Error(`no "## \`${original}\`" section in the symbol map`);
  const modules = {};
  for (const line of lines.slice(heading + 1)) {
    if (line.startsWith('## ')) break;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 7) continue;
    const symbol = /^`([^`]+)`$/.exec(cells[2]);
    const module = /^`([^`]+)`$/.exec(cells[5]);
    if (symbol && module) modules[symbol[1]] = module[1];
  }
  if (Object.keys(modules).length === 0) throw new Error(`the "${original}" section has no declarations`);
  return { original, modules };
}

/** Loads the map for `original`: from `mapFile` when given, otherwise from scripts/module-maps/. */
export function loadModuleMap(root, original, mapFile) {
  const wanted = toPosix(original);
  if (mapFile) {
    const text = readFileSync(path.resolve(root, mapFile), 'utf8');
    const raw = mapFile.endsWith('.md') ? parseSymbolMapMarkdown(text, wanted) : JSON.parse(text);
    const map = normaliseMap(raw, mapFile);
    if (map.original !== wanted) throw new Error(`${mapFile} maps ${map.original}, not ${wanted}`);
    return map;
  }
  const dir = path.join(root, MAP_DIR);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  for (const f of files.sort()) {
    const raw = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    if (toPosix(raw.original ?? '') === wanted) return normaliseMap(raw, `${MAP_DIR}/${f}`);
  }
  throw new Error(`no module map in ${MAP_DIR}/ has "original": "${wanted}"`);
}
