// Finds and strips comments in .ts/.mjs/.js and .astro files, for the comment-length guard and for
// proving a comments-only change left every code token alone.
//
//   node scripts/comments.mjs --compare <git-ref> <file>...   token-compares each file with <ref>
//   node scripts/comments.mjs --blocks <min-lines> <file>...  lists comment blocks of at least N lines
//
// Code (a .ts file, an .astro frontmatter or <script>) is read with the TypeScript parser. Astro
// markup and <style> blocks are compared as text with <!-- --> and /* */ removed and whitespace
// collapsed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const isJsDocNode = (n) => n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode;
const lineAt = (text, pos) => text.slice(0, pos).split('\n').length;

/** An .astro file cut into code, markup and style segments; any other file is one code segment. */
export function segments(fileName, text) {
  text = text.replace(/\r\n/g, '\n');
  if (fileName.endsWith('.css')) return [{ kind: 'style', start: 0, text }];
  if (!fileName.endsWith('.astro')) return [{ kind: 'code', start: 0, text }];
  const out = [];
  let rest = 0;
  const fm = /^(\s*---\r?\n)([\s\S]*?)\r?\n---/.exec(text);
  if (fm) {
    out.push({ kind: 'code', start: fm[1].length, text: fm[2] });
    rest = fm[0].length;
  }
  // A self-closing <script ... /> has no body.
  const block = /<(script|style)\b(?:[^>]*[^>/])?>([\s\S]*?)<\/\1>/g;
  block.lastIndex = rest;
  let m;
  while ((m = block.exec(text))) {
    const bodyStart = m.index + m[0].indexOf('>') + 1;
    out.push({ kind: 'markup', start: rest, text: text.slice(rest, bodyStart) });
    out.push({ kind: m[1] === 'script' ? 'code' : 'style', start: bodyStart, text: m[2] });
    rest = bodyStart + m[2].length;
  }
  out.push({ kind: 'markup', start: rest, text: text.slice(rest) });
  return out;
}

function parse(code) {
  return ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Leaf token texts of a TypeScript segment, comments and JSDoc excluded. */
function codeTokens(code) {
  const sf = parse(code);
  const out = [];
  const visit = (n) => {
    if (isJsDocNode(n)) return;
    const kids = n.getChildren(sf);
    if (kids.length > 0) return kids.forEach(visit);
    if (n.kind === ts.SyntaxKind.EndOfFileToken) return;
    const t = n.getText(sf);
    if (t !== '') out.push(t);
  };
  visit(sf);
  return out;
}

/** Comment ranges in a TypeScript segment, read from the trivia before each token. */
function codeComments(code) {
  const sf = parse(code);
  const seen = new Map();
  const add = (ranges) =>
    (ranges ?? []).forEach((r) => seen.set(r.pos, { pos: r.pos, end: r.end, multi: r.kind === ts.SyntaxKind.MultiLineCommentTrivia }));
  const visit = (n) => {
    if (isJsDocNode(n)) return;
    const kids = n.getChildren(sf);
    if (kids.length > 0) return kids.forEach(visit);
    add(ts.getLeadingCommentRanges(code, n.pos));
    add(ts.getTrailingCommentRanges(code, n.end));
  };
  visit(sf);
  return [...seen.values()].sort((a, b) => a.pos - b.pos);
}

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
// In markup a // comment is a whole line inside a {} expression; a // anywhere else is text.
const MARKUP_LINE_COMMENT = /^[ \t]*\/\/[^\n]*/gm;
const MARKUP_COMMENT = /<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|^[ \t]*\/\/[^\n]*/gm;
// A {/* */} expression holds nothing but its comment, so it goes with it.
const EXPRESSION_COMMENT = /\{\s*\/\*[\s\S]*?\*\/\s*\}/g;

function textTokens(text, kind) {
  const stripped = text.replace(EXPRESSION_COMMENT, ' ').replace(HTML_COMMENT, ' ').replace(BLOCK_COMMENT, ' ');
  return (kind === 'markup' ? stripped.replace(MARKUP_LINE_COMMENT, ' ') : stripped)
    .split(/\s+/)
    .filter(Boolean);
}

/** Every code token of a file, in order, with all comments removed. */
export function stripComments(fileName, text) {
  return segments(fileName, text).flatMap((s) =>
    (s.kind === 'code' ? codeTokens(s.text) : textTokens(s.text, s.kind)).map((t) => `${s.kind}:${t}`),
  );
}

/**
 * Comment blocks of a file: a block comment, an HTML comment, or a run of // comments on
 * consecutive lines. Lines are 1-based; start and end are offsets into the text with CRLF read as LF.
 */
export function commentBlocks(fileName, text) {
  text = text.replace(/\r\n/g, '\n');
  const blocks = [];
  for (const s of segments(fileName, text)) {
    const ranges =
      s.kind === 'code'
        ? codeComments(s.text)
        : [...s.text.matchAll(s.kind === 'markup' ? MARKUP_COMMENT : BLOCK_COMMENT)].map((m) => {
            const line = /^[ \t]*\/\//.test(m[0]);
            const pos = m.index + (line ? m[0].indexOf('//') : 0);
            return { pos, end: m.index + m[0].length, multi: !line };
          });
    let prev = null;
    for (const r of ranges) {
      const startLine = lineAt(text, s.start + r.pos);
      const endLine = lineAt(text, s.start + r.end);
      const body = s.text.slice(r.pos, r.end);
      const between = prev ? s.text.slice(prev.end, r.pos) : '';
      if (prev && !r.multi && !prev.multi && endLine === prev.block.endLine + 1 && /^\s*$/.test(between)) {
        prev.block.endLine = endLine;
        prev.block.end = s.start + r.end;
        prev.block.text += `\n${body}`;
      } else {
        const block = { startLine, endLine, start: s.start + r.pos, end: s.start + r.end, text: body };
        blocks.push(block);
        prev = { block, multi: r.multi };
      }
      prev.end = r.end;
      prev.multi = r.multi;
    }
  }
  return blocks.map((b) => ({ ...b, lines: b.endLine - b.startLine + 1 }));
}

/** First differing token of two token lists, or null when they are equal. */
export function firstDifference(was, now) {
  const n = Math.max(was.length, now.length);
  for (let i = 0; i < n; i++) {
    if (was[i] !== now[i]) return { index: i, was: was.slice(i, i + 5), now: now.slice(i, i + 5) };
  }
  return null;
}

function main(argv) {
  const [mode, arg, ...files] = argv;
  if (mode === '--compare') {
    let failed = 0;
    for (const f of files) {
      const now = stripComments(f, readFileSync(f, 'utf8'));
      const was = stripComments(f, execFileSync('git', ['show', `${arg}:${f}`], { encoding: 'utf8' }));
      const d = firstDifference(was, now);
      if (d) failed++;
      console.log(`${d ? 'DIFF' : 'same'} ${f} (${now.length} tokens)${d ? ` at ${JSON.stringify(d)}` : ''}`);
    }
    console.log(`${files.length} files, ${failed} with token differences`);
    process.exitCode = failed ? 1 : 0;
  } else if (mode === '--blocks') {
    for (const f of files) {
      for (const b of commentBlocks(f, readFileSync(f, 'utf8'))) {
        if (b.lines >= Number(arg)) console.log(`${f}:${b.startLine} ${b.lines}`);
      }
    }
  } else {
    console.error('usage: node scripts/comments.mjs --compare <ref> <file>... | --blocks <min-lines> <file>...');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
