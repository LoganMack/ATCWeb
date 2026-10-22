// Points every importer of a split file at the modules that now define what it imports
// (functional spec Delivery item 3; FR4.2: no re-export shim, so every importer must change).
//
// Usage:
//   node scripts/rewrite-imports.mjs <original> [--map <file.json|symbol-map.md>] [--dry-run]
//       e.g. node scripts/rewrite-imports.mjs src/lib/bigModule.ts
//
// The module map (scripts/module-maps/, see scripts/module-map.mjs) says which module defines each
// name. Every `import { … } from '<original>'` and `export { … } from '<original>'` under src/,
// tests/ and scripts/ (.ts, .tsx, .mts, .js, .mjs, and the frontmatter and <script> blocks of
// .astro files) is replaced by one statement per defining module, in the order the names first
// appear. Statement-level `import type` stays type-only; a group made only of inline `type` names
// becomes `import type { … }`; aliases and inline `type` markers are kept. The new specifier is
// relative to the importer, with the original's extension style and quote character.
//
// Default, namespace and side-effect imports of the original, and dynamic import() or vi.mock()
// strings that name it, can't be split by name: they are listed and the script exits 1 without
// writing anything. Prints a per-file summary and the totals. Only import lines change.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { loadModuleMap, toPosix } from './module-map.mjs';

const ROOTS = ['src', 'tests', 'scripts'];
const EXTENSIONS = /\.(ts|tsx|mts|js|mjs|astro)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro']);
const PRINT_WIDTH = 110;

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    if (SKIP_DIRS.has(e.name)) return [];
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return EXTENSIONS.test(e.name) ? [p] : [];
  });
}

/** The parts of a file that hold code: [{ start, text }]. */
export function codeRegions(fileName, text) {
  if (!fileName.endsWith('.astro')) return [{ start: 0, text }];
  const regions = [];
  const fm = /^(\s*---\r?\n)([\s\S]*?)\r?\n---/.exec(text);
  if (fm) regions.push({ start: fm[1].length, text: fm[2] });
  // Only the markup after the frontmatter: the frontmatter can mention "<script" in a string or comment.
  const script = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  script.lastIndex = fm ? fm[0].length : 0;
  for (let m = script.exec(text); m; m = script.exec(text)) {
    regions.push({ start: m.index + m[0].indexOf('>') + 1, text: m[1] });
  }
  return regions;
}

/** Does `spec`, written in `fromFile` (root-relative, posix), name the original file? */
export function namesOriginal(fromFile, spec, original) {
  if (!spec.startsWith('.')) return false;
  const p = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const bare = original.replace(/\.(ts|tsx|mts)$/, '');
  return p === original || p === bare || p.replace(/\.(m?js)$/, '') === bare;
}

/** The specifier for `target` (root-relative) as seen from `fromFile`, in the original's style. */
export function specifierFor(fromFile, target, keepExtension) {
  let rel = path.posix.relative(path.posix.dirname(fromFile), target);
  if (!keepExtension) rel = rel.replace(/\.(ts|tsx|mts)$/, '');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function render(keyword, names, spec, quote, indent, eol) {
  const tail = ` from ${quote}${spec}${quote};`;
  const oneLine = `${keyword} { ${names.join(', ')} }${tail}`;
  if (indent.length + oneLine.length <= PRINT_WIDTH) return oneLine;
  const inner = names.map((n) => `${indent}  ${n},`).join(eol);
  return `${keyword} {${eol}${inner}${eol}${indent}}${tail}`;
}

/**
 * The edits for one file: { edits: [{ start, end, text }], problems: string[], statements: number }.
 * `fromFile` is root-relative and posix.
 */
export function planFile(fromFile, text, map) {
  const edits = [];
  const problems = [];
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  for (const region of codeRegions(fromFile, text)) {
    const sf = ts.createSourceFile(fromFile, region.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const lineOf = (node) => text.slice(0, region.start + node.getStart(sf)).split('\n').length;

    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        node.arguments.length > 0 &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          /\b(vi|jest)\.\w+$/.test(node.expression.getText(sf))) &&
        namesOriginal(fromFile, node.arguments[0].text, map.original)
      ) {
        problems.push(
          `${fromFile}:${lineOf(node)}: \`${node.getText(sf)}\` names ${map.original}; change it by hand`,
        );
      }
      node.forEachChild(visit);
    };
    visit(sf);

    for (const stmt of sf.statements) {
      const isImport = ts.isImportDeclaration(stmt);
      const isExport = ts.isExportDeclaration(stmt);
      if (!isImport && !isExport) continue;
      const specNode = stmt.moduleSpecifier;
      if (!specNode || !ts.isStringLiteral(specNode)) continue;
      if (!namesOriginal(fromFile, specNode.text, map.original)) continue;

      const where = `${fromFile}:${lineOf(stmt)}`;
      let elements;
      let keyword;
      if (isImport) {
        const clause = stmt.importClause;
        if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
          problems.push(`${where}: only named imports can be split: \`${stmt.getText(sf)}\``);
          continue;
        }
        elements = [...clause.namedBindings.elements];
        keyword = clause.isTypeOnly ? 'import type' : 'import';
      } else {
        if (!stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) {
          problems.push(`${where}: \`export *\` can't be split: \`${stmt.getText(sf)}\``);
          continue;
        }
        elements = [...stmt.exportClause.elements];
        keyword = stmt.isTypeOnly ? 'export type' : 'export';
      }

      const groups = new Map();
      for (const el of elements) {
        const name = (el.propertyName ?? el.name).text;
        const target = map.modules[name];
        if (!target) {
          problems.push(`${where}: ${name} is not in the module map for ${map.original}`);
          continue;
        }
        if (!groups.has(target)) groups.set(target, []);
        groups.get(target).push(el);
      }
      if (groups.size === 0) continue;

      const quote = specNode.getText(sf)[0];
      const keepExtension = /\.(ts|tsx|mts)$/.test(specNode.text);
      const start = region.start + stmt.getStart(sf);
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const indent = /^[ \t]*/.exec(text.slice(lineStart, start))[0];
      const statements = [];
      for (const [target, els] of groups) {
        const allInlineTypes = !keyword.endsWith(' type') && els.every((el) => el.isTypeOnly);
        const kw = allInlineTypes ? `${keyword} type` : keyword;
        const names = els.map((el) =>
          allInlineTypes ? el.getText(sf).replace(/^type\s+/, '') : el.getText(sf),
        );
        statements.push(render(kw, names, specifierFor(fromFile, target, keepExtension), quote, indent, eol));
      }
      edits.push({
        start,
        end: region.start + stmt.getEnd(),
        text: statements.join(`${eol}${indent}`),
        summary: `${where}: ${[...groups.keys()].map((t) => path.posix.basename(t)).join(', ')}`,
      });
    }
  }
  return { edits, problems };
}

export function applyEdits(text, edits) {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

function main(argv) {
  const args = [...argv];
  const dryRun = args.includes('--dry-run');
  const mapIndex = args.indexOf('--map');
  const mapFile = mapIndex >= 0 ? args[mapIndex + 1] : undefined;
  if (mapIndex >= 0) args.splice(mapIndex, 2);
  const positional = args.filter((a) => !a.startsWith('--'));
  if (positional.length !== 1) {
    console.error('usage: node scripts/rewrite-imports.mjs <original> [--map <file>] [--dry-run]');
    return 2;
  }
  const root = process.cwd();
  const map = loadModuleMap(root, positional[0], mapFile);

  const plans = [];
  const problems = [];
  for (const abs of ROOTS.flatMap((r) => walk(path.join(root, r)))) {
    const rel = toPosix(path.relative(root, abs));
    const text = readFileSync(abs, 'utf8');
    if (!text.includes(path.posix.basename(map.original).replace(/\.\w+$/, ''))) continue;
    const plan = planFile(rel, text, map);
    problems.push(...plan.problems);
    if (plan.edits.length > 0) plans.push({ abs, rel, text, edits: plan.edits });
  }

  if (problems.length > 0) {
    console.error(`rewrite-imports: ${problems.length} import(s) need a hand change; nothing written:`);
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }
  let statements = 0;
  for (const p of plans) {
    statements += p.edits.length;
    if (!dryRun) writeFileSync(p.abs, applyEdits(p.text, p.edits));
    for (const e of p.edits) console.log(`  ${e.summary}`);
  }
  console.log(
    `rewrite-imports: ${map.original} (map ${map.source}): ${statements} import statement(s) in ${plans.length} file(s) ${dryRun ? 'would be rewritten (dry run)' : 'rewritten'}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`rewrite-imports: ${err.message}`);
    process.exitCode = 2;
  }
}
