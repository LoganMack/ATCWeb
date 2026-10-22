// Move-only proof for the module split (functional spec W4; BR1.1, BR1.2, FR4.4).
//
// Usage:
//   node scripts/move-check.mjs <original> [--map <file.json|symbol-map.md>] [--base <rev>]
//       Compares <original> as it was at <base> with the modules its map names, as they are in the
//       working tree. <base> defaults to the merge base of HEAD and main (so it is the PR's base
//       commit before and after committing). Exits 1 on any difference.
//   node scripts/move-check.mjs --self-test
//       Runs only the self-test (it also runs before every check, and from npm test).
//
// What it compares, using the TypeScript parser's own tokens:
//   - Comments, whitespace, import declarations and `export` keywords are ignored, so formatting,
//     moved doc comments, new import lines and a private helper gaining `export` never count.
//   - Each file is cut into top-level declarations keyed by name (a `const a, b` statement is keyed
//     "a,b"); other top-level statements (page frontmatter code) are keyed by their order.
//   - Both directions: every original declaration must appear in exactly one module with the same
//     tokens (and in the module the map names), and every module declaration must come from the
//     original or be on the map's newDeclarations list.
//   - Export coverage: every export of the original is exported by exactly one module, and no
//     module re-exports (`export … from`), so there is no shim. With originalDeleted, the original
//     must be gone and each mapped folder may hold only mapped modules (no index.ts).
//   - Wrapper moves and named rewrites, for pages (see the map fields below).
// For an .astro original only the frontmatter is read.
//
// Map fields (scripts/module-maps/<name>.json; see scripts/module-map.mjs):
//   original          the file being split, e.g. "src/lib/bigModule.ts"
//   originalDeleted   true for a library split (default); false for a page that keeps its frontmatter
//   folders           folders that must hold only mapped modules (default: the modules' folders);
//                     for a page (originalDeleted false) every .ts file in them is compared, so a
//                     support module's declarations must be mapped or on newDeclarations
//   modules           { "<declaration>": "<module path>" }; a page keeps a declaration by mapping it
//                     to its own path
//   newDeclarations   names the modules may declare that the original did not
//   rewrites          [{ "name", "from", "to" }] token rewrites applied to wrapper bodies only, e.g.
//                     { "name": "astro-redirect", "from": "Astro.redirect(X, 302)", "to": "ctx.redirect(X)" }.
//                     A single capital letter is a placeholder for a balanced run of tokens; a
//                     pattern ends with a literal token.
//   wrappers          [{ "name", "module", "source", "rewrites"?, "contextParam"?, "returns"?, "pageCall"? }]
//                     A wrapper function `name` in `module` whose body is original code:
//                       source { "type": "run", "from": "<tokens>", "to": "<tokens>" } is the run of
//                         top-level statements from the first one starting with `from` through the
//                         first one starting with `to` (declarations the map moves elsewhere excluded);
//                       source { "type": "if", "condition": "<tokens>" } is the body of the one
//                         `if (<condition>)` anywhere in the original;
//                       source { "type": "closure", "name": "<name>" } is the body of the one
//                         `const <name> = (…) => { … };` anywhere in the original.
//                     The body is compared after the named rewrites (all of them when "rewrites" is
//                     omitted; a placeholder's tokens are rewritten too), and the rewrites applied
//                     are listed per wrapper. One leading `const { … } = <contextParam>;` (default
//                     ctx) is allowed.
//                     "returns": true requires the body to end with `return { names }`, each a name
//                     the run declares. "pageCall": true requires the page to replace the run with
//                     `const|let { the same names } = [await] name(…);` in the same place.
//   listedRemovals    token prefixes of original statements (any depth) that are expected to go
//   listedAdditions   token prefixes of statements (any depth) expected to appear in the kept page
//
// Dependency: typescript (already a dev dependency). Node built-ins otherwise.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { loadModuleMap, toPosix } from './module-map.mjs';

// --- Parsing and tokens -------------------------------------------------------------------

/** The code to compare: an .astro file's frontmatter, any other file whole. */
export function codeOf(fileName, text) {
  if (!fileName.endsWith('.astro')) return { code: text, lineOffset: 0 };
  const m = /^(\s*---\r?\n)([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { code: '', lineOffset: 0 };
  return { code: m[2], lineOffset: m[1].split('\n').length - 1 };
}

function parse(fileName, text) {
  const { code, lineOffset } = codeOf(fileName, text);
  const sf = ts.createSourceFile(
    fileName.replace(/\.astro$/, '.ts'),
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return { fileName, sf, lineOffset };
}

const isJsDocNode = (n) => n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode;

/** Leaf tokens of `node`, skipping JSDoc, the nodes in `skip` and the leaves starting at `drop`. */
function tokensOf(file, node, skip = new Set(), drop = new Set()) {
  const out = [];
  const visit = (n) => {
    if (skip.has(n) || isJsDocNode(n)) return;
    const kids = n.getChildren(file.sf);
    if (kids.length > 0) {
      for (const k of kids) visit(k);
      return;
    }
    if (n.kind === ts.SyntaxKind.EndOfFileToken) return;
    const start = n.getStart(file.sf);
    if (drop.has(start)) return;
    const text = n.getText(file.sf);
    if (text === '') return;
    const line = file.sf.getLineAndCharacterOfPosition(start).line + 1 + file.lineOffset;
    out.push({ text, line, file: file.fileName });
  };
  visit(node);
  return out;
}

/** Start positions of a top-level statement's `export` keywords, which the comparison drops. */
function exportKeywordStarts(file, stmt) {
  const starts = new Set();
  for (const m of stmt.modifiers ?? []) {
    if (m.kind === ts.SyntaxKind.ExportKeyword) starts.add(m.getStart(file.sf));
  }
  return starts;
}

const isExported = (stmt) => (stmt.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

function bindingNames(name, out) {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
  return out;
}

/** The names a top-level statement declares, or null for a statement that declares nothing. */
function declNames(stmt) {
  if (
    ts.isFunctionDeclaration(stmt) ||
    ts.isClassDeclaration(stmt) ||
    ts.isInterfaceDeclaration(stmt) ||
    ts.isTypeAliasDeclaration(stmt) ||
    ts.isEnumDeclaration(stmt) ||
    ts.isModuleDeclaration(stmt)
  ) {
    return stmt.name ? [stmt.name.text] : null;
  }
  if (ts.isVariableStatement(stmt)) {
    const names = [];
    for (const d of stmt.declarationList.declarations) bindingNames(d.name, names);
    return names;
  }
  return null;
}

/** Every token of a source text as the comparison sees it: comments, whitespace and imports kept out. */
export function sourceTokens(fileName, text) {
  const file = parse(fileName, text);
  return file.sf.statements.filter((s) => !ts.isImportDeclaration(s)).flatMap((s) => tokensOf(file, s));
}

/** Tokens of a short source pattern, e.g. "Astro.redirect(X, 302)". Patterns hold no template literals. */
export function patternTokens(src) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, src);
  const out = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    out.push(scanner.getTokenText());
  }
  return out;
}

const startsWithTokens = (tokens, prefix) =>
  prefix.length > 0 && prefix.length <= tokens.length && prefix.every((t, i) => tokens[i].text === t);

const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);
const isPlaceholder = (t) => /^[A-Z]$/.test(t);

function matchAt(tokens, start, pattern) {
  const binds = {};
  let i = start;
  for (let k = 0; k < pattern.length; k++) {
    const p = pattern[k];
    if (!isPlaceholder(p)) {
      if (tokens[i]?.text !== p) return null;
      i++;
      continue;
    }
    const next = pattern[k + 1];
    if (next === undefined || isPlaceholder(next)) return null;
    const from = i;
    let depth = 0;
    while (i < tokens.length) {
      const t = tokens[i].text;
      if (depth === 0 && i > from && t === next) break;
      if (OPENERS.has(t)) depth++;
      else if (CLOSERS.has(t)) {
        if (depth === 0) return null;
        depth--;
      }
      i++;
    }
    if (i >= tokens.length || i === from) return null;
    binds[p] = tokens.slice(from, i);
  }
  return { end: i, binds };
}

/** Applies the named token rewrites left to right; returns the new tokens and a count per rule. */
export function applyRewrites(tokens, rules) {
  const compiled = rules.map((r) => ({ name: r.name, from: patternTokens(r.from), to: patternTokens(r.to) }));
  const counts = new Map(rules.map((r) => [r.name, 0]));
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    let applied = false;
    for (const rule of compiled) {
      const m = matchAt(tokens, i, rule.from);
      if (!m) continue;
      const at = tokens[i];
      for (const t of rule.to) {
        if (isPlaceholder(t) && m.binds[t]) {
          // A placeholder's tokens are rewritten too: `Astro.redirect(`…${Astro.url.search}`, 302)`.
          const inner = applyRewrites(m.binds[t], rules);
          out.push(...inner.tokens);
          for (const [name, n] of inner.counts) counts.set(name, counts.get(name) + n);
        } else out.push({ text: t, line: at.line, file: at.file });
      }
      counts.set(rule.name, counts.get(rule.name) + 1);
      i = m.end;
      applied = true;
      break;
    }
    if (!applied) out.push(tokens[i++]);
  }
  return { tokens: out, counts };
}

const show = (tokens, i) =>
  tokens
    .slice(Math.max(0, i - 3), i + 4)
    .map((t) => t.text)
    .join(' ');

/** Null when equal, otherwise one message naming both sides of the first differing token. */
function diffTokens(was, now) {
  const n = Math.min(was.length, now.length);
  let i = 0;
  while (i < n && was[i].text === now[i].text) i++;
  if (i === was.length && i === now.length) return null;
  if (i === now.length) {
    const w = was[i];
    return `ends early: ${w.file}:${w.line} continues with \`${show(was, i)}\``;
  }
  if (i === was.length) {
    const t = now[i];
    return `${t.file}:${t.line}: extra tokens \`${show(now, i)}\``;
  }
  const t = now[i];
  const w = was[i];
  return `${t.file}:${t.line}: \`${show(now, i)}\` where ${w.file}:${w.line} has \`${show(was, i)}\``;
}

// --- The comparison -----------------------------------------------------------------------

function findIfStatements(file, conditionTokens) {
  const found = [];
  const visit = (n) => {
    if (ts.isIfStatement(n)) {
      const cond = tokensOf(file, n.expression);
      if (cond.length === conditionTokens.length && startsWithTokens(cond, conditionTokens)) found.push(n);
    }
    n.forEachChild(visit);
  };
  visit(file.sf);
  return found;
}

/** Statements at any depth whose tokens start with `prefix`. */
function findStatements(file, prefix) {
  const found = [];
  const visit = (n) => {
    if (ts.isStatement(n) && startsWithTokens(tokensOf(file, n), prefix)) {
      found.push(n);
      return;
    }
    n.forEachChild(visit);
  };
  for (const s of file.sf.statements) visit(s);
  return found;
}

const isTopLevel = (file, node) => node.parent === file.sf;

/** Top-level `const|let { names } = [await] callee(…);` → the names, or null. */
function pageCallNames(stmt, callee) {
  if (!ts.isVariableStatement(stmt) || stmt.declarationList.declarations.length !== 1) return null;
  const d = stmt.declarationList.declarations[0];
  if (!ts.isObjectBindingPattern(d.name) || !d.initializer) return null;
  let init = d.initializer;
  if (ts.isAwaitExpression(init)) init = init.expression;
  if (!ts.isCallExpression(init) || !ts.isIdentifier(init.expression) || init.expression.text !== callee) {
    return null;
  }
  const names = [];
  for (const el of d.name.elements) {
    if (el.propertyName || el.dotDotDotToken || !ts.isIdentifier(el.name)) return null;
    names.push(el.name.text);
  }
  return names;
}

function wrapperFunction(file, name) {
  for (const s of file.sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name?.text === name && s.body) return { stmt: s, body: s.body };
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        const init = d.initializer;
        if (ts.isIdentifier(d.name) && d.name.text === name && init && ts.isArrowFunction(init)) {
          if (ts.isBlock(init.body)) return { stmt: s, body: init.body };
        }
      }
    }
  }
  return null;
}

/** `const name = (…) => { … };` → the arrow function, or null. */
function closureFunction(stmt, name) {
  if (!ts.isVariableStatement(stmt) || stmt.declarationList.declarations.length !== 1) return null;
  const d = stmt.declarationList.declarations[0];
  const init = d.initializer;
  if (!ts.isIdentifier(d.name) || d.name.text !== name || !init || !ts.isArrowFunction(init)) return null;
  return ts.isBlock(init.body) ? init : null;
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * Compares an original file with the modules it was split into.
 *   original  { path, text }   the file at the PR's base
 *   after     { path, text } | null   the same path in the working tree, when it still exists
 *   modules   [{ path, text }]   every new module (not the original path)
 *   config    a normalised module map
 * Returns { differences: string[], notes: string[], stats }.
 */
export function compareMove({ original, after, modules, config }) {
  const differences = [];
  const notes = [];
  const origFile = parse(original.path, original.text);
  const afterFile = after ? parse(after.path, after.text) : null;
  const modFiles = modules.map((m) => parse(m.path, m.text));
  const allNew = afterFile ? [afterFile, ...modFiles] : modFiles;

  if (config.originalDeleted && after) differences.push(`${original.path} still exists (it must be deleted)`);

  const consumedTop = new Set();
  const consumedNested = new Set();
  const consumedAfterTop = new Set();
  const consumedAfterNested = new Set();
  const wrapperDecls = new Map(); // module path -> Set of wrapper function names
  const origPlaceholders = new Map(); // top-level statement index -> wrapper name
  const afterPlaceholders = new Map();
  const rewriteTotals = new Map((config.rewrites ?? []).map((r) => [r.name, 0]));

  const consume = (file, node, top, nested) => (isTopLevel(file, node) ? top : nested).add(node);

  // Listed page-side differences.
  for (const src of config.listedRemovals) {
    const found = findStatements(origFile, patternTokens(src));
    if (found.length === 0) differences.push(`listed removal \`${src}\` matches nothing in ${original.path}`);
    for (const n of found) consume(origFile, n, consumedTop, consumedNested);
    notes.push(`listed removal: \`${src}\` (${found.length})`);
  }
  for (const src of config.listedAdditions) {
    const found = afterFile ? findStatements(afterFile, patternTokens(src)) : [];
    if (found.length === 0)
      differences.push(`listed addition \`${src}\` matches nothing in ${original.path}`);
    for (const n of found) consume(afterFile, n, consumedAfterTop, consumedAfterNested);
    notes.push(`listed addition: \`${src}\` (${found.length})`);
  }

  // Wrapper moves.
  for (const w of config.wrappers) {
    const label = `wrapper ${w.name}`;
    const stmts = [...origFile.sf.statements];
    let body = [];
    let declared = [];
    if (w.source?.type === 'run') {
      const from = patternTokens(w.source.from);
      const to = patternTokens(w.source.to);
      const i = stmts.findIndex((s) => startsWithTokens(tokensOf(origFile, s), from));
      const j = i < 0 ? -1 : stmts.findIndex((s, k) => k >= i && startsWithTokens(tokensOf(origFile, s), to));
      if (i < 0 || j < 0) {
        differences.push(
          `${label}: no run from \`${w.source.from}\` to \`${w.source.to}\` in ${original.path}`,
        );
        continue;
      }
      for (const s of stmts.slice(i, j + 1)) {
        const names = declNames(s);
        if (names && names.some((n) => config.modules[n])) continue; // moved as a declaration
        body.push(s);
        consumedTop.add(s);
        if (names) declared.push(...names);
      }
      origPlaceholders.set(i, w.name);
    } else if (w.source?.type === 'if') {
      const found = findIfStatements(origFile, patternTokens(w.source.condition));
      if (found.length !== 1) {
        differences.push(
          `${label}: ${found.length} \`if (${w.source.condition})\` blocks in ${original.path}`,
        );
        continue;
      }
      const then = found[0].thenStatement;
      body = ts.isBlock(then) ? [...then.statements] : [then];
      consume(origFile, found[0], consumedTop, consumedNested);
    } else if (w.source?.type === 'closure') {
      const found = findStatements(origFile, patternTokens(`const ${w.source.name} =`))
        .map((s) => ({ s, fn: closureFunction(s, w.source.name) }))
        .filter((c) => c.fn);
      if (found.length !== 1) {
        differences.push(`${label}: ${found.length} \`const ${w.source.name} = (…) => { … }\` in ${original.path}`);
        continue;
      }
      body = [...found[0].fn.body.statements];
      consume(origFile, found[0].s, consumedTop, consumedNested);
    } else {
      differences.push(`${label}: source.type must be "run", "if" or "closure"`);
      continue;
    }

    const rules = w.rewrites
      ? (config.rewrites ?? []).filter((r) => w.rewrites.includes(r.name))
      : (config.rewrites ?? []);
    const rewritten = applyRewrites(
      body.flatMap((s) => tokensOf(origFile, s, consumedNested)),
      rules,
    );
    for (const [name, n] of rewritten.counts) rewriteTotals.set(name, (rewriteTotals.get(name) ?? 0) + n);
    const applied = [...rewritten.counts].filter(([, n]) => n > 0).map(([name, n]) => `${name} x${n}`);
    notes.push(`${label}: rewrites ${applied.length > 0 ? applied.join(', ') : 'none'}`);

    const modFile =
      modFiles.find((f) => f.fileName === w.module) ?? (afterFile?.fileName === w.module ? afterFile : null);
    const fn = modFile ? wrapperFunction(modFile, w.name) : null;
    if (!fn) {
      differences.push(`${label}: no function ${w.name} in ${w.module}`);
      continue;
    }
    if (!wrapperDecls.has(w.module)) wrapperDecls.set(w.module, new Set());
    wrapperDecls.get(w.module).add(w.name);

    const inner = [...fn.body.statements];
    const ctxName = w.contextParam ?? 'ctx';
    const first = inner[0];
    if (
      first &&
      ts.isVariableStatement(first) &&
      first.declarationList.declarations.length === 1 &&
      ts.isObjectBindingPattern(first.declarationList.declarations[0].name) &&
      first.declarationList.declarations[0].initializer &&
      ts.isIdentifier(first.declarationList.declarations[0].initializer) &&
      first.declarationList.declarations[0].initializer.text === ctxName
    ) {
      inner.shift();
      notes.push(`${label}: leading \`const { … } = ${ctxName};\``);
    }
    let returnNames = [];
    if (w.returns) {
      const last = inner[inner.length - 1];
      const obj = last && ts.isReturnStatement(last) ? last.expression : null;
      if (
        !obj ||
        !ts.isObjectLiteralExpression(obj) ||
        !obj.properties.every(ts.isShorthandPropertyAssignment)
      ) {
        differences.push(`${label}: the body must end with \`return { names }\``);
      } else {
        inner.pop();
        returnNames = obj.properties.map((p) => p.name.text);
        for (const n of returnNames) {
          if (!declared.includes(n))
            differences.push(`${label}: returns ${n}, which the moved run does not declare`);
        }
      }
    }
    const d = diffTokens(
      rewritten.tokens,
      inner.flatMap((s) => tokensOf(modFile, s)),
    );
    if (d) differences.push(`${label}: ${d}`);

    if (w.pageCall) {
      const k = afterFile
        ? afterFile.sf.statements.findIndex((s) => {
            const names = pageCallNames(s, w.name);
            return names !== null && sameSet(names, returnNames);
          })
        : -1;
      if (k < 0) {
        differences.push(`${label}: the page has no \`const { ${returnNames.join(', ')} } = ${w.name}(…);\``);
      } else {
        consumedAfterTop.add(afterFile.sf.statements[k]);
        afterPlaceholders.set(k, w.name);
      }
    }
  }

  // Declarations and other top-level statements on each side.
  const collect = (file, consumed, nested) => {
    const decls = new Map();
    const others = [];
    const exported = new Set();
    const reexports = [];
    file.sf.statements.forEach((s, index) => {
      if (ts.isImportDeclaration(s) || ts.isImportEqualsDeclaration(s)) return;
      if (ts.isExportDeclaration(s)) {
        if (s.moduleSpecifier) reexports.push(s);
        else if (s.exportClause && ts.isNamedExports(s.exportClause)) {
          for (const el of s.exportClause.elements) exported.add(el.name.text);
        }
        return;
      }
      if (consumed.has(s)) return;
      const names = declNames(s);
      const tokens = tokensOf(file, s, nested, exportKeywordStarts(file, s));
      const line = file.sf.getLineAndCharacterOfPosition(s.getStart(file.sf)).line + 1 + file.lineOffset;
      if (names && names.length > 0) {
        const key = names.join(',');
        if (isExported(s)) names.forEach((n) => exported.add(n));
        const entry = decls.get(key);
        if (entry) {
          entry.count++;
          entry.tokens.push(...tokens);
        } else decls.set(key, { key, names, tokens, line, count: 1, file: file.fileName });
      } else {
        others.push({ index, tokens, line });
      }
    });
    return { decls, others, exported, reexports };
  };

  const orig = collect(origFile, consumedTop, consumedNested);
  const news = allNew.map((f) =>
    f === afterFile ? collect(f, consumedAfterTop, consumedAfterNested) : collect(f, new Set(), new Set()),
  );

  // Every module declaration, by key.
  const index = new Map();
  allNew.forEach((f, i) => {
    for (const entry of news[i].decls.values()) {
      if (wrapperDecls.get(f.fileName)?.has(entry.key)) continue;
      if (!index.has(entry.key)) index.set(entry.key, []);
      index.get(entry.key).push(entry);
    }
  });

  let matched = 0;
  for (const entry of orig.decls.values()) {
    const found = index.get(entry.key) ?? [];
    if (found.length === 0) {
      differences.push(`missing: ${entry.key} (${original.path}:${entry.line}) is in no module`);
      continue;
    }
    if (found.length > 1) {
      differences.push(
        `duplicated: ${entry.key} is declared in ${found.map((f) => `${f.file}:${f.line}`).join(', ')}`,
      );
      continue;
    }
    const [now] = found;
    if (now.count > entry.count) {
      differences.push(`duplicated: ${entry.key} is declared ${now.count} times in ${now.file}`);
      continue;
    }
    const mapped = config.modules[entry.names[0]];
    if (mapped && mapped !== now.file) {
      differences.push(`misplaced: ${entry.key} is in ${now.file}, but the map puts it in ${mapped}`);
    }
    const d = diffTokens(entry.tokens, now.tokens);
    if (d) differences.push(`changed: ${entry.key}: ${d}`);
    else matched++;
  }

  const listedNew = new Set(config.newDeclarations);
  for (const [key, found] of index) {
    if (orig.decls.has(key)) continue;
    for (const f of found) {
      if (f.names.every((n) => listedNew.has(n))) notes.push(`new declaration: ${key} (${f.file}:${f.line})`);
      else differences.push(`extra: ${key} (${f.file}:${f.line}) is not in the original`);
    }
  }

  for (const name of Object.keys(config.modules)) {
    if (![...orig.decls.values()].some((e) => e.names.includes(name)) && !consumedNamesInclude(name)) {
      differences.push(`map: ${name} is not a top-level declaration of ${original.path}`);
    }
  }
  function consumedNamesInclude(name) {
    for (const s of consumedTop) if ((declNames(s) ?? []).includes(name)) return true;
    return false;
  }

  // Other top-level statements, in order, with wrapper calls in place of their runs.
  const origSeq = [];
  orig.others.forEach((o) => origSeq.push(o));
  for (const [i, name] of origPlaceholders) origSeq.push({ index: i, placeholder: name });
  origSeq.sort((a, b) => a.index - b.index);
  const afterSeq = [];
  if (afterFile) {
    news[0].others.forEach((o) => afterSeq.push(o));
    for (const [i, name] of afterPlaceholders) afterSeq.push({ index: i, placeholder: name });
    afterSeq.sort((a, b) => a.index - b.index);
  }
  const n = Math.max(origSeq.length, afterSeq.length);
  for (let i = 0; i < n; i++) {
    const was = origSeq[i];
    const now = afterSeq[i];
    if (!now) {
      differences.push(`missing: statement at ${original.path}:${was.line ?? '?'} is not in the kept page`);
      continue;
    }
    if (!was) {
      differences.push(`extra: statement at ${original.path}:${now.line ?? '?'} (working tree)`);
      continue;
    }
    if (was.placeholder || now.placeholder) {
      if (was.placeholder !== now.placeholder) {
        differences.push(
          `order: expected ${was.placeholder ?? 'a statement'} where the page has ${now.placeholder ?? 'a statement'}`,
        );
      }
      continue;
    }
    const d = diffTokens(was.tokens, now.tokens);
    if (d) differences.push(`changed statement: ${d}`);
  }
  modFiles.forEach((f, i) => {
    for (const o of news[allNew.indexOf(f)].others) {
      differences.push(`extra: top-level statement at ${f.fileName}:${o.line}`);
    }
    for (const r of news[allNew.indexOf(f)].reexports) {
      const line = f.sf.getLineAndCharacterOfPosition(r.getStart(f.sf)).line + 1;
      differences.push(`re-export: ${f.fileName}:${line} re-exports another module (no shims)`);
    }
    void i;
  });

  // Export coverage.
  let exportsChecked = 0;
  for (const name of orig.exported) {
    exportsChecked++;
    const by = allNew.filter((f, i) => news[i].exported.has(name)).map((f) => f.fileName);
    if (by.length !== 1) {
      differences.push(`export: ${name} is exported by ${by.length === 0 ? 'no module' : by.join(', ')}`);
    }
  }

  for (const [name, count] of rewriteTotals) notes.push(`rewrite ${name}: applied ${count} time(s)`);

  return {
    differences,
    notes,
    stats: { declarations: orig.decls.size, matched, exports: exportsChecked, modules: modFiles.length },
  };
}

// --- Self-test ----------------------------------------------------------------------------

const SPLIT_ORIGINAL = `/** Header comment. */
import { helper } from './helper';

export interface Delta {
  d: number;
}

/** Doubles big numbers. */
export function alpha(x: number): number {
  if (x > 1) {
    return x * 2;
  }
  return helper(x);
}

export const BETA = 3;

function gamma(): number {
  return BETA + alpha(1);
}

export function useGamma(): number {
  return gamma();
}
`;

const SPLIT_A = `import { helper } from '../helper';

// Doubles big numbers (the comment moved and changed, which does not count).
export function alpha(x: number): number {
  if (x > 1) { return x * 2; }
  return helper(x);
}

export interface Delta { d: number; }
`;

const SPLIT_B = `import { alpha } from './a';

export const BETA = 3;

export function gamma(): number {
  return BETA + alpha(1);
}

export function useGamma(): number { return gamma(); }
`;

const SPLIT_CONFIG = {
  original: 'lib/thing.ts',
  originalDeleted: true,
  modules: {
    Delta: 'lib/thing/a.ts',
    alpha: 'lib/thing/a.ts',
    BETA: 'lib/thing/b.ts',
    gamma: 'lib/thing/b.ts',
    useGamma: 'lib/thing/b.ts',
  },
  newDeclarations: [],
  rewrites: [],
  wrappers: [],
  listedRemovals: [],
  listedAdditions: [],
};

const PAGE_ORIGINAL = `---
import { save } from '../lib/db';
const form = await Astro.request.formData();
const intent = String(form.get('intent') ?? '');
if (intent === 'save') {
  const target = Astro.url.pathname;
  await save(target);
  return Astro.redirect(target, 302);
}
let total = 0;
for (const n of [1, 2]) total += n;
const label = \`T\${total}\`;
const shown = label.toUpperCase();
---
<p>{shown}</p>
`;

const PAGE_AFTER = `---
import { handleSave } from '../lib/actions/save';
import { loadTotals } from '../lib/actions/load';
const form = await Astro.request.formData();
const intent = String(form.get('intent') ?? '');
const ctx = { url: Astro.url, redirect: (location: string) => ({ location, status: 302 as const }) };
if (intent === 'save') {
  const r = await handleSave(ctx, form, intent);
  return Astro.redirect(r.location, r.status);
}
const { total, label } = loadTotals();
const shown = label.toUpperCase();
---
<p>{shown}</p>
`;

const PAGE_SAVE = `import { save } from '../db';
import type { Ctx } from './context';

export async function handleSave(ctx: Ctx, form: FormData, intent: string) {
  const { url } = ctx;
  const target = ctx.url.pathname;
  await save(target);
  return ctx.redirect(target);
}
`;

const PAGE_LOAD = `export function loadTotals() {
  let total = 0;
  for (const n of [1, 2]) total += n;
  const label = \`T\${total}\`;
  return { total, label };
}
`;

const PAGE_CONFIG = {
  original: 'pages/p.astro',
  originalDeleted: false,
  modules: {},
  newDeclarations: [],
  rewrites: [
    { name: 'astro-redirect', from: 'Astro.redirect(X, 302)', to: 'ctx.redirect(X)' },
    { name: 'astro-url', from: 'Astro.url', to: 'ctx.url' },
  ],
  wrappers: [
    {
      name: 'handleSave',
      module: 'lib/actions/save.ts',
      source: { type: 'if', condition: "intent === 'save'" },
    },
    {
      name: 'loadTotals',
      module: 'lib/actions/load.ts',
      source: { type: 'run', from: 'let total = 0', to: 'const label =' },
      returns: true,
      pageCall: true,
    },
  ],
  listedRemovals: [],
  listedAdditions: ['const ctx =', "if (intent === 'save')"],
};

// A page whose POST handlers and their shared closure move out, dispatched from a handler map.
const HANDLERS_ORIGINAL = `---
const form = await Astro.request.formData();
const intent = String(form.get('intent') ?? '');
if (form) {
  const back = (anchor: string) => {
    const url = new URL(Astro.url);
    return Astro.redirect(\`/p\${url.search}#\${anchor}\`, 302);
  };
  if (intent === 'one') {
    return back('a');
  }
  if (intent === 'two') {
    return Astro.redirect(\`/p\${Astro.url.search}\`, 302);
  }
}
const shown = intent.toUpperCase();
---
<p>{shown}</p>
`;

const HANDLERS_AFTER = `---
import { HANDLERS } from '../lib/actions/map';
const form = await Astro.request.formData();
const intent = String(form.get('intent') ?? '');
const ctx = { url: Astro.url, redirect: (location: string) => ({ location, status: 302 as const }) };
const toResponse = (r: { location: string; status: 302 }) => Astro.redirect(r.location, r.status);
if (form) {
  const handler = HANDLERS.get(intent);
  if (handler) return toResponse(await handler(ctx, form, intent));
}
const shown = intent.toUpperCase();
---
<p>{shown}</p>
`;

const HANDLERS_MODULES = {
  'lib/actions/shared.ts': `export function back(ctx: Ctx, anchor: string) {
  const url = new URL(ctx.url);
  return ctx.redirect(\`/p\${url.search}#\${anchor}\`);
}
`,
  'lib/actions/one.ts': `export async function handleOne(ctx: Ctx, form: FormData, intent: string) {
  return back(ctx, 'a');
}
`,
  'lib/actions/two.ts': `export async function handleTwo(ctx: Ctx, form: FormData, intent: string) {
  return ctx.redirect(\`/p\${ctx.url.search}\`);
}
`,
};

const HANDLERS_CONFIG = {
  original: 'pages/h.astro',
  originalDeleted: false,
  modules: {},
  newDeclarations: ['ctx', 'toResponse'],
  rewrites: [
    { name: 'astro-redirect', from: 'Astro.redirect(X, 302)', to: 'ctx.redirect(X)' },
    { name: 'astro-url', from: 'Astro.url', to: 'ctx.url' },
    { name: 'back-ctx', from: 'back(', to: 'back(ctx, ' },
  ],
  wrappers: [
    { name: 'back', module: 'lib/actions/shared.ts', source: { type: 'closure', name: 'back' } },
    { name: 'handleOne', module: 'lib/actions/one.ts', source: { type: 'if', condition: "intent === 'one'" } },
    { name: 'handleTwo', module: 'lib/actions/two.ts', source: { type: 'if', condition: "intent === 'two'" } },
  ],
  listedRemovals: [],
  listedAdditions: ['const handler = HANDLERS.get(intent)', 'if (handler) return toResponse('],
};

function handlersCase(edit = (files) => files) {
  return compareMove({
    original: { path: 'pages/h.astro', text: HANDLERS_ORIGINAL },
    after: { path: 'pages/h.astro', text: HANDLERS_AFTER },
    modules: Object.entries(edit({ ...HANDLERS_MODULES })).map(([p, text]) => ({ path: p, text })),
    config: HANDLERS_CONFIG,
  });
}

function splitCase(edit = (files) => files) {
  const files = edit({ 'lib/thing/a.ts': SPLIT_A, 'lib/thing/b.ts': SPLIT_B });
  return compareMove({
    original: { path: 'lib/thing.ts', text: SPLIT_ORIGINAL },
    after: null,
    modules: Object.entries(files).map(([p, text]) => ({ path: p, text })),
    config: SPLIT_CONFIG,
  });
}

function pageCase(config = PAGE_CONFIG) {
  return compareMove({
    original: { path: 'pages/p.astro', text: PAGE_ORIGINAL },
    after: { path: 'pages/p.astro', text: PAGE_AFTER },
    modules: [
      { path: 'lib/actions/save.ts', text: PAGE_SAVE },
      { path: 'lib/actions/load.ts', text: PAGE_LOAD },
    ],
    config,
  });
}

function replaceOnce(text, from, to) {
  if (!text.includes(from)) throw new Error(`self-test fixture does not contain ${JSON.stringify(from)}`);
  return text.replace(from, to);
}

/** The planted cases W4.7 requires, plus one for page handler moves. Each must produce at least one difference. */
export const SELF_TEST_CASES = [
  {
    name: 'a one-token change',
    run: () =>
      splitCase((f) => ({ ...f, 'lib/thing/a.ts': replaceOnce(f['lib/thing/a.ts'], 'x * 2', 'x * 3') })),
    expect: /^changed: alpha: .*x \* 3/,
  },
  {
    name: 'an inserted statement',
    run: () =>
      splitCase((f) => ({
        ...f,
        'lib/thing/a.ts': replaceOnce(
          f['lib/thing/a.ts'],
          'return helper(x);',
          'helper(0);\n  return helper(x);',
        ),
      })),
    expect: /^changed: alpha: .*helper \( 0 \)/,
  },
  {
    name: 'a deleted }',
    run: () =>
      splitCase((f) => ({
        ...f,
        'lib/thing/a.ts': replaceOnce(f['lib/thing/a.ts'], 'return x * 2; }', 'return x * 2;'),
      })),
    expect: /^(changed|missing): (alpha|Delta)/,
  },
  {
    name: 'a duplicated declaration',
    run: () =>
      splitCase((f) => ({
        ...f,
        'lib/thing/b.ts': `${f['lib/thing/b.ts']}\nfunction alpha(x: number): number {\n  if (x > 1) { return x * 2; }\n  return helper(x);\n}\n`,
      })),
    expect: /^duplicated: alpha/,
  },
  {
    name: 'a missing declaration',
    run: () =>
      splitCase((f) => ({
        ...f,
        'lib/thing/a.ts': replaceOnce(f['lib/thing/a.ts'], 'export interface Delta { d: number; }', ''),
      })),
    expect: /^missing: Delta/,
  },
  {
    name: 'an unlisted rewrite',
    run: () =>
      pageCase({ ...PAGE_CONFIG, rewrites: PAGE_CONFIG.rewrites.filter((r) => r.name !== 'astro-url') }),
    expect: /^wrapper handleSave: .*ctx \. url/,
  },
  {
    name: 'a changed shared closure',
    run: () =>
      handlersCase((f) => ({
        ...f,
        'lib/actions/shared.ts': replaceOnce(f['lib/actions/shared.ts'], '#${anchor}', '#x${anchor}'),
      })),
    expect: /^wrapper back: /,
  },
];

/** Runs both clean fixtures (which must show no difference) and every planted case. */
export function runSelfTest() {
  const baselines = [
    { name: 'clean split', result: splitCase() },
    { name: 'clean page with wrappers and rewrites', result: pageCase() },
    { name: 'clean page with a handler map and a shared closure', result: handlersCase() },
  ];
  const cases = SELF_TEST_CASES.map((c) => {
    const result = c.run();
    const hit = result.differences.find((d) => c.expect.test(d));
    return { name: c.name, result, caught: hit !== undefined, report: hit };
  });
  const ok = baselines.every((b) => b.result.differences.length === 0) && cases.every((c) => c.caught);
  return { ok, baselines, cases };
}

function printSelfTest(st) {
  for (const b of st.baselines) {
    const n = b.result.differences.length;
    console.log(`  ${n === 0 ? 'ok  ' : 'FAIL'} ${b.name}: ${n} difference(s)`);
    for (const d of b.result.differences) console.log(`         ${d}`);
  }
  for (const c of st.cases) {
    console.log(`  ${c.caught ? 'ok  ' : 'FAIL'} catches ${c.name}: ${c.report ?? 'not reported'}`);
    if (!c.caught) for (const d of c.result.differences) console.log(`         (reported instead) ${d}`);
  }
}

// --- CLI ----------------------------------------------------------------------------------

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function defaultBase(root) {
  for (const branch of ['main', 'origin/main']) {
    try {
      return git(root, ['merge-base', 'HEAD', branch]);
    } catch {
      // try the next candidate
    }
  }
  return 'HEAD';
}

function listTs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listTs(p);
    return /\.(ts|tsx|mts)$/.test(e.name) ? [p] : [];
  });
}

export function runCheck(root, originalArg, { mapFile, base } = {}) {
  const config = loadModuleMap(root, originalArg, mapFile);
  const rev = base ?? defaultBase(root);
  const original = { path: config.original, text: git(root, ['show', `${rev}:${config.original}`]) };
  const afterPath = path.join(root, config.original);
  const after = existsSync(afterPath)
    ? { path: config.original, text: readFileSync(afterPath, 'utf8') }
    : null;

  const modulePaths = new Set(Object.values(config.modules));
  for (const w of config.wrappers) modulePaths.add(w.module);
  if (!config.originalDeleted) {
    for (const folder of config.folders) {
      for (const abs of listTs(path.join(root, folder))) modulePaths.add(toPosix(path.relative(root, abs)));
    }
  }
  modulePaths.delete(config.original);

  const missingFiles = [];
  const modules = [];
  for (const p of [...modulePaths].sort()) {
    const abs = path.join(root, p);
    if (!existsSync(abs)) missingFiles.push(`missing file: ${p}`);
    else modules.push({ path: p, text: readFileSync(abs, 'utf8') });
  }
  const strayFiles = [];
  if (config.originalDeleted) {
    for (const folder of config.folders) {
      for (const abs of listTs(path.join(root, folder))) {
        const p = toPosix(path.relative(root, abs));
        if (!modulePaths.has(p))
          strayFiles.push(`unmapped file: ${p} is not in the module map (no index or shim files)`);
      }
    }
  }
  const result = compareMove({ original, after, modules, config });
  result.differences.unshift(...missingFiles, ...strayFiles);
  return { config, rev, result };
}

function main(argv) {
  const args = [...argv];
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const value = args[i + 1];
    args.splice(i, 2);
    return value;
  };
  const selfTestOnly = args.includes('--self-test');
  const mapFile = flag('--map');
  const base = flag('--base');
  const positional = args.filter((a) => !a.startsWith('--'));

  const st = runSelfTest();
  if (selfTestOnly || !st.ok) {
    console.log(`move-check self-test: ${st.ok ? 'passed' : 'FAILED'}`);
    printSelfTest(st);
    return st.ok ? 0 : 1;
  }
  if (positional.length !== 1) {
    console.error(
      'usage: node scripts/move-check.mjs <original> [--map <file>] [--base <rev>] | --self-test',
    );
    return 2;
  }

  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  const { config, rev, result } = runCheck(root, positional[0], { mapFile, base });
  const { differences, notes, stats } = result;
  console.log(
    `move-check: ${config.original} at ${rev.slice(0, 10)} against ${stats.modules} module(s) (map ${config.source})`,
  );
  console.log(`  self-test: passed (${st.cases.length} planted cases caught)`);
  console.log(`  declarations: ${stats.matched} of ${stats.declarations} matched token for token`);
  console.log(`  exports: ${stats.exports} checked, each must be exported by exactly one module`);
  for (const n of notes) console.log(`  ${n}`);
  console.log(`  differences: ${differences.length}`);
  for (const d of differences) console.log(`    ${d}`);
  return differences.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`move-check: ${err.message}`);
    process.exitCode = 2;
  }
}
