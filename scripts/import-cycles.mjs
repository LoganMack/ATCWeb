// Value-import cycle check for src/lib (functional spec W5.2; BR1.4).
//
// Usage:
//   node scripts/import-cycles.mjs
//       Builds the graph of value imports between the .ts files under src/lib (no .astro files,
//       no tests) and exits 1 when it has a cycle, printing each one.
//
// Type-only edges are left out, because they vanish at build time: `import type { … }`,
// `export type { … } from`, and imports whose every named specifier is an inline `type`
// (`import { type A, type B } from`). A type edge written as a value import counts, so it shows
// up as a cycle. Side-effect imports (`import './x'`) and re-exports count as value edges.
// tests/structure/import-cycles.test.ts runs the same check through findCycles().

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

/** Module specifiers `text` imports at run time (type-only imports left out). */
export function valueImports(fileName, text) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const specs = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const clause = stmt.importClause;
      if (clause?.isTypeOnly) continue;
      const named =
        clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings : null;
      const onlyInlineTypes =
        clause &&
        !clause.name &&
        named &&
        named.elements.length > 0 &&
        named.elements.every((e) => e.isTypeOnly);
      if (onlyInlineTypes) continue;
      specs.push(stmt.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      if (stmt.isTypeOnly) continue;
      const named = stmt.exportClause && ts.isNamedExports(stmt.exportClause) ? stmt.exportClause : null;
      if (named && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly)) continue;
      specs.push(stmt.moduleSpecifier.text);
    }
  }
  return specs;
}

function resolve(fromFile, spec, files) {
  if (!spec.startsWith('.')) return null;
  const p = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const candidates = [p, `${p}.ts`, p.replace(/\.(m?js)$/, '.ts'), `${p}/index.ts`];
  return candidates.find((c) => files.has(c)) ?? null;
}

/** `files` maps a root-relative posix path ("src/lib/x.ts") to its text; returns path -> Set of paths. */
export function buildGraph(files) {
  const names = new Map(Object.entries(files).map(([p, text]) => [p.replace(/^\/+/, ''), text]));
  const graph = new Map();
  for (const [file, text] of names) {
    const edges = new Set();
    for (const spec of valueImports(file, text)) {
      const target = resolve(file, spec, names);
      if (target) edges.add(target);
    }
    graph.set(file, edges);
  }
  return graph;
}

/** One concrete cycle per strongly connected component (Tarjan), each as [a, b, …, a]. */
export function findCycles(files) {
  const graph = buildGraph(files);
  let counter = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  const strongConnect = (v) => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v)) {
      if (!index.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  };
  for (const v of [...graph.keys()].sort()) if (!index.has(v)) strongConnect(v);

  const cycles = [];
  for (const component of components) {
    const members = new Set(component);
    const start = [...component].sort()[0];
    if (component.length === 1 && !graph.get(start).has(start)) continue;
    // Shortest path from start back to itself inside the component.
    const prev = new Map();
    const queue = [start];
    const seen = new Set([start]);
    let end = null;
    while (queue.length > 0 && end === null) {
      const v = queue.shift();
      for (const w of [...graph.get(v)].sort()) {
        if (!members.has(w)) continue;
        if (w === start) {
          end = v;
          break;
        }
        if (!seen.has(w)) {
          seen.add(w);
          prev.set(w, v);
          queue.push(w);
        }
      }
    }
    // start -> … -> end -> start, rebuilt from `end` through the breadth-first parents.
    const nodes = [end];
    while (nodes[0] !== start) nodes.unshift(prev.get(nodes[0]));
    cycles.push([...nodes, start]);
  }
  return cycles;
}

function listTs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listTs(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

function main() {
  const root = process.cwd();
  const files = {};
  for (const abs of listTs(path.join(root, 'src', 'lib'))) {
    files[path.relative(root, abs).split(path.sep).join('/')] = readFileSync(abs, 'utf8');
  }
  const cycles = findCycles(files);
  console.log(
    `import-cycles: ${Object.keys(files).length} files under src/lib, ${cycles.length} value-import cycle(s)`,
  );
  for (const c of cycles) console.log(`  ${c.join(' -> ')}`);
  return cycles.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
