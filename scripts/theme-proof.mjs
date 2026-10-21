// Compile-time colour proof for the theme-token change (spec W3.1; BR2.2, BR2.3).
//
// Usage:
//   node scripts/theme-proof.mjs
//       Compiles the working tree's tailwind.config.mjs and global.css, compares every colour
//       against the frozen tests/fixtures/theme/before.css, prints the first differences and
//       exits 1 on any difference or on any `.light` rule that sets a non-custom property.
//   Imported by tests/theme/compiled-colours.test.ts, which runs the same checks.
//
// How it works:
//   - Synthetic elements: every distinct class list (with its tag and static attributes) in
//     src/**/*.{astro,ts}. Template expressions are expanded into their string-literal
//     alternatives. For the before run, fixed-family swaps (tests/fixtures/theme/swaps.json)
//     are rewritten back to their original classes.
//   - Scenarios: the states each element's rules imply (hover, focus, focus-visible, active,
//     checked, open, aria-pressed and other attribute states, ::placeholder,
//     ::file-selector-button, group-hover / group-focus-within ancestors, peer siblings,
//     component ancestors such as [data-sticky-thead] thead), plus the element at rest.
//   - Cascade: the real compiled order, specificity, !important and media queries (evaluated at
//     375px and 1600px), matched with postcss-selector-parser against the synthetic element and
//     its ancestors (html with or without .light, body, ...). Custom properties inherit and
//     var() is substituted; calc(), min() and max() are evaluated; colours are normalised to
//     rgba and compared with a tolerance of 0.002 per channel (0-1 scale).
//   - A property with no winning declaration takes its inherited or initial value, so a
//     declaration that exists in only one run counts as equal only when it matches that value.

import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { ROOT, FIXTURE_DIR, compileCss } from './theme-inventory.mjs';

export const TOLERANCE = 0.002;
export const WIDTHS = [375, 1600];
export const THEMES = ['dark', 'light'];

export const COMPARED = [
  'color',
  'background-color',
  'background-image',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'text-decoration-color',
  '--tw-ring-color',
  '--tw-gradient-from',
  '--tw-gradient-via',
  '--tw-gradient-to',
  '--tw-gradient-stops',
  'box-shadow',
  'fill',
  'stroke',
  'filter',
  'opacity',
  'caret-color',
  'accent-color',
  'text-shadow',
];

const INHERITED = new Set(['color', 'fill', 'stroke', 'caret-color', 'accent-color', 'text-shadow']);
const INITIAL = {
  color: 'canvastext',
  'background-color': 'transparent',
  'background-image': 'none',
  'border-top-color': 'currentcolor',
  'border-right-color': 'currentcolor',
  'border-bottom-color': 'currentcolor',
  'border-left-color': 'currentcolor',
  'outline-color': 'currentcolor',
  'text-decoration-color': 'currentcolor',
  'box-shadow': 'none',
  fill: 'black',
  stroke: 'none',
  filter: 'none',
  opacity: '1',
  'caret-color': 'auto',
  'accent-color': 'auto',
  'text-shadow': 'none',
};

// Longhand -> shorthands that also set it.
const SHORTHANDS = {
  'background-color': ['background'],
  'background-image': ['background'],
  'border-top-color': ['border', 'border-color', 'border-top', 'border-block-start', 'border-block'],
  'border-right-color': ['border', 'border-color', 'border-right', 'border-inline-end', 'border-inline'],
  'border-bottom-color': ['border', 'border-color', 'border-bottom', 'border-block-end', 'border-block'],
  'border-left-color': ['border', 'border-color', 'border-left', 'border-inline-start', 'border-inline'],
  'outline-color': ['outline'],
  'text-decoration-color': ['text-decoration'],
};
const LOGICAL = {
  'border-inline-start-color': 'border-left-color',
  'border-inline-end-color': 'border-right-color',
  'border-block-start-color': 'border-top-color',
  'border-block-end-color': 'border-bottom-color',
};

const INTERACTIVE = new Set([
  'hover',
  'focus',
  'focus-visible',
  'focus-within',
  'active',
  'checked',
  'disabled',
  'visited',
  'first-child',
  'last-child',
  'only-child',
  'first-of-type',
  'last-of-type',
  'empty',
  'required',
  'invalid',
  'indeterminate',
  'placeholder-shown',
  'autofill',
  'read-only',
  'target',
  'open',
]);
const PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);

// ---------------------------------------------------------------------------------------
// Selectors

function isPseudoElement(node) {
  return node.value.startsWith('::') || PSEUDO_ELEMENTS.has(node.value.replace(/^:+/, ''));
}

function unquote(v) {
  if (v == null) return v;
  return v.replace(/^(['"])([\s\S]*)\1$/, '$2');
}

function specificityOf(selector) {
  let a = 0;
  let b = 0;
  let c = 0;
  for (const node of selector.nodes) {
    if (node.type === 'id') a++;
    else if (node.type === 'class' || node.type === 'attribute') b++;
    else if (node.type === 'tag') c++;
    else if (node.type === 'pseudo') {
      const name = node.value.replace(/^:+/, '').toLowerCase();
      if (isPseudoElement(node)) c++;
      else if (name === 'where') continue;
      else if (name === 'not' || name === 'is' || name === 'matches' || name === 'has') {
        let best = [0, 0, 0];
        for (const inner of node.nodes) {
          const s = specificityOf(inner);
          if (compareSpec(s, best) > 0) best = s;
        }
        a += best[0];
        b += best[1];
        c += best[2];
      } else b++;
    }
  }
  return [a, b, c];
}

function compareSpec(x, y) {
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** Splits a selector AST into compounds joined by combinators. */
function toCompounds(selector) {
  const compounds = [];
  const combinators = [];
  let cur = newCompound();
  for (const node of selector.nodes) {
    if (node.type === 'combinator') {
      compounds.push(cur);
      combinators.push(node.value.trim() || ' ');
      cur = newCompound();
      continue;
    }
    if (node.type === 'comment') continue;
    if (node.type === 'tag') cur.tag = node.value.toLowerCase();
    else if (node.type === 'universal') cur.universal = true;
    else if (node.type === 'class') cur.classes.push(node.value);
    else if (node.type === 'id') cur.ids.push(node.value);
    else if (node.type === 'attribute') {
      cur.attrs.push({
        name: node.attribute.toLowerCase(),
        op: node.operator || null,
        value: node.operator ? unquote(node.value) : null,
      });
    } else if (node.type === 'pseudo') {
      const name = node.value.replace(/^:+/, '').toLowerCase();
      if (isPseudoElement(node)) cur.pseudoElement = name;
      else cur.pseudos.push({ name, args: node.nodes.map((n) => toCompounds(n)) });
    } else if (node.type === 'nesting') cur.unsupported = true;
  }
  compounds.push(cur);
  return { compounds, combinators };
}

function newCompound() {
  return { tag: null, universal: false, classes: [], ids: [], attrs: [], pseudos: [], pseudoElement: null };
}

// ---------------------------------------------------------------------------------------
// Stylesheet model

const parserCache = new Map();

function parseSelectorList(text) {
  if (parserCache.has(text)) return parserCache.get(text);
  let root;
  try {
    root = selectorParser().astSync(text);
  } catch (err) {
    // A selector the proof cannot read would silently drop out of the comparison.
    throw new Error(`theme-proof: cannot parse selector "${text}": ${err.message}`, { cause: err });
  }
  const out = root.nodes.map((sel) => ({
    text: sel.toString().trim(),
    spec: specificityOf(sel),
    ...toCompounds(sel),
  }));
  parserCache.set(text, out);
  return out;
}

function mediaMatches(params, env) {
  return params.split(',').some((part) => {
    const q = part.trim().toLowerCase();
    if (!q) return false;
    if (q.startsWith('not ')) return !mediaMatches(q.slice(4), env);
    return q.split(/\s+and\s+/).every((cond) => {
      const c = cond.trim();
      if (c === 'screen' || c === 'all' || c === 'only screen') return true;
      if (c === 'print') return false;
      const m = c.match(/^\(\s*([a-z-]+)\s*:\s*([^)]+?)\s*\)$/);
      if (!m) return false;
      const [, feature, raw] = m;
      const px = parseFloat(raw) * (raw.endsWith('rem') || raw.endsWith('em') ? 16 : 1);
      if (feature === 'min-width') return env.width >= px;
      if (feature === 'max-width') return env.width <= px;
      if (feature === 'prefers-reduced-motion') return raw === 'no-preference';
      if (feature === 'hover') return raw === 'hover';
      if (feature === 'pointer') return raw === 'fine';
      return false;
    });
  });
}

/** Parses compiled CSS into ordered rules with an index by the rightmost compound. */
export function buildSheet(css) {
  const root = postcss.parse(css);
  const rules = [];
  let order = 0;
  root.walkRules((rule) => {
    const media = [];
    for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
      if (p.type === 'atrule') {
        const name = p.name.toLowerCase();
        if (name.endsWith('keyframes')) return;
        if (name === 'media') media.push(p.params);
        else if (name !== 'supports' && name !== 'layer') return;
      }
    }
    const selectors = parseSelectorList(rule.selector).filter((s) => !s.compounds.some((c) => c.unsupported));
    if (!selectors.length) return;
    const decls = [];
    for (const node of rule.nodes || []) {
      if (node.type !== 'decl') continue;
      decls.push({
        prop: node.prop.startsWith('--') ? node.prop : node.prop.toLowerCase(),
        value: node.value,
        important: !!node.important,
        order: order++,
      });
    }
    if (!decls.length) return;
    rules.push({ selector: rule.selector, selectors, decls, media });
  });

  const index = new Map();
  const add = (key, entry) => {
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(entry);
  };
  rules.forEach((rule, ri) => {
    rule.selectors.forEach((sel, si) => {
      const last = sel.compounds[sel.compounds.length - 1];
      const entry = { ri, si };
      if (last.classes.length) add(`c:${last.classes[0]}`, entry);
      else if (last.attrs.length) {
        const a = last.attrs[0];
        if (a.name === 'class' && a.op === '~=') add(`c:${a.value}`, entry);
        else add(`a:${a.name}`, entry);
      } else if (last.ids.length) add(`i:${last.ids[0]}`, entry);
      else if (last.tag) add(`t:${last.tag}`, entry);
      else add('*', entry);
    });
  });
  const classes = new Set();
  for (const r of rules)
    for (const s of r.selectors)
      for (const c of s.compounds) {
        c.classes.forEach((x) => classes.add(x));
        c.attrs.filter((a) => a.name === 'class' && a.op === '~=').forEach((a) => classes.add(a.value));
      }
  return { rules, index, classes };
}

function candidateEntries(sheet, node) {
  const keys = ['*', `t:${node.tag}`];
  for (const c of node.classes) keys.push(`c:${c}`);
  for (const a of Object.keys(node.attrs)) keys.push(`a:${a}`);
  const seen = new Set();
  const out = [];
  for (const k of keys) {
    for (const e of sheet.index.get(k) || []) {
      const id = `${e.ri}:${e.si}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(e);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Synthetic DOM matching

/** node: { tag, classes: string[], attrs: {name: value}, states: Set, parent, prev: node[] }. */
function matchAttr(node, a) {
  if (a.name === 'class') {
    if (!a.op) return node.classes.length > 0;
    if (a.op === '~=') return node.classes.includes(a.value);
    return matchAttrValue(node.classes.join(' '), a);
  }
  if (!(a.name in node.attrs)) return false;
  if (!a.op) return true;
  return matchAttrValue(String(node.attrs[a.name]), a);
}

function matchAttrValue(v, a) {
  switch (a.op) {
    case '=':
      return v === a.value;
    case '~=':
      return v.split(/\s+/).includes(a.value);
    case '^=':
      return v.startsWith(a.value);
    case '$=':
      return v.endsWith(a.value);
    case '*=':
      return v.includes(a.value);
    case '|=':
      return v === a.value || v.startsWith(`${a.value}-`);
    default:
      return false;
  }
}

function matchCompound(c, node) {
  if (c.tag && c.tag !== node.tag) return false;
  if (c.ids.length) return false;
  for (const cls of c.classes) if (!node.classes.includes(cls)) return false;
  for (const a of c.attrs) if (!matchAttr(node, a)) return false;
  for (const p of c.pseudos) if (!matchPseudo(p, node)) return false;
  return true;
}

function matchPseudo(p, node) {
  switch (p.name) {
    case 'not':
      return !p.args.some((sel) => matchSelectorAt(sel, sel.compounds.length - 1, node));
    case 'is':
    case 'where':
    case 'matches':
      return p.args.some((sel) => matchSelectorAt(sel, sel.compounds.length - 1, node));
    case 'root':
      return node.tag === 'html';
    case 'enabled':
      return !node.states.has('disabled');
    default:
      return node.states.has(p.name);
  }
}

function matchSelectorAt(sel, i, node) {
  if (!node) return false;
  if (!matchCompound(sel.compounds[i], node)) return false;
  if (i === 0) return true;
  const comb = sel.combinators[i - 1];
  if (comb === '>') return matchSelectorAt(sel, i - 1, node.parent);
  if (comb === ' ') {
    for (let p = node.parent; p; p = p.parent) if (matchSelectorAt(sel, i - 1, p)) return true;
    return false;
  }
  if (comb === '+') return matchSelectorAt(sel, i - 1, node.prev[node.prev.length - 1]);
  if (comb === '~') return node.prev.some((s) => matchSelectorAt(sel, i - 1, s));
  return false;
}

/** Whether a selector matches the target (an element, or a pseudo-element of one). */
function selectorMatches(sel, target) {
  const last = sel.compounds[sel.compounds.length - 1];
  const wantPseudo = target.pseudo || null;
  if ((last.pseudoElement || null) !== wantPseudo) return false;
  for (const c of sel.compounds.slice(0, -1)) if (c.pseudoElement) return false;
  return matchSelectorAt(sel, sel.compounds.length - 1, target.pseudo ? target.element : target);
}

// ---------------------------------------------------------------------------------------
// Values

const INVALID = Symbol('invalid');

function findClose(str, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === quote && str[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTop(str, sep) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && (sep === ' ' ? /\s/.test(ch) : ch === sep)) {
      out.push(str.slice(start, i));
      start = i + 1;
    }
  }
  out.push(str.slice(start));
  return out.map((s) => s.trim()).filter((s, i, arr) => s !== '' || (sep !== ' ' && arr.length === 1));
}

/** Replaces var() references; returns INVALID for an undefined variable with no fallback. */
function substitute(value, lookup, depth = 0) {
  if (depth > 30) return INVALID;
  let out = '';
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf('var(', i);
    if (at === -1) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, at);
    const close = findClose(value, at + 3);
    if (close === -1) return INVALID;
    const inner = value.slice(at + 4, close);
    const comma = splitTop(inner, ',');
    const name = comma[0].trim();
    const fallback = inner.includes(',') ? inner.slice(inner.indexOf(',') + 1) : null;
    let rep = lookup(name);
    if (rep === undefined || rep === INVALID) {
      if (fallback === null) return INVALID;
      rep = substitute(fallback.trim(), lookup, depth + 1);
      if (rep === INVALID) return INVALID;
    }
    out += rep;
    i = close + 1;
  }
  return out;
}

/** Evaluates a unitless numeric expression with calc(), min(), max(), + - * / and %. */
export function evalNumber(expr) {
  const src = expr.trim();
  let pos = 0;
  const peek = () => src[pos];
  const ws = () => {
    while (pos < src.length && /\s/.test(src[pos])) pos++;
  };
  function parseExpr() {
    let v = parseTerm();
    for (;;) {
      ws();
      const ch = peek();
      if (ch === '+' || ch === '-') {
        pos++;
        const r = parseTerm();
        v = ch === '+' ? v + r : v - r;
      } else return v;
    }
  }
  function parseTerm() {
    let v = parseFactor();
    for (;;) {
      ws();
      const ch = peek();
      if (ch === '*' || ch === '/') {
        pos++;
        const r = parseFactor();
        v = ch === '*' ? v * r : v / r;
      } else return v;
    }
  }
  function parseArgs() {
    const args = [parseExpr()];
    ws();
    while (peek() === ',') {
      pos++;
      args.push(parseExpr());
      ws();
    }
    if (peek() !== ')') throw new Error(`bad expression: ${src}`);
    pos++;
    return args;
  }
  function parseFactor() {
    ws();
    const rest = src.slice(pos);
    let m;
    if ((m = rest.match(/^(calc|min|max|clamp)\(/i))) {
      pos += m[0].length;
      const args = parseArgs();
      const fn = m[1].toLowerCase();
      if (fn === 'calc') return args[0];
      if (fn === 'min') return Math.min(...args);
      if (fn === 'max') return Math.max(...args);
      return Math.min(Math.max(args[1], args[0]), args[2]);
    }
    if (peek() === '(') {
      pos++;
      const v = parseExpr();
      ws();
      if (peek() !== ')') throw new Error(`bad expression: ${src}`);
      pos++;
      return v;
    }
    if (peek() === '-') {
      pos++;
      return -parseFactor();
    }
    if ((m = rest.match(/^(\d*\.?\d+(?:e[+-]?\d+)?)(%?)/i))) {
      pos += m[0].length;
      return m[2] ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
    }
    throw new Error(`bad expression: ${src}`);
  }
  const v = parseExpr();
  ws();
  if (pos !== src.length) throw new Error(`bad expression: ${src}`);
  return v;
}

const NAMED = {
  transparent: [0, 0, 0, 0],
  white: [1, 1, 1, 1],
  black: [0, 0, 0, 1],
  canvastext: [0, 0, 0, 1],
};

function hexToRgba(hex) {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
  const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
  return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
}

function parseColourFn(name, inner) {
  let channels;
  let alpha = '1';
  const slash = splitTop(inner, '/');
  if (slash.length === 2) {
    channels = splitTop(slash[0], ' ');
    alpha = slash[1];
  } else {
    const commas = splitTop(inner, ',');
    if (commas.length >= 3) {
      channels = commas.slice(0, 3);
      if (commas[3] !== undefined) alpha = commas[3];
    } else channels = splitTop(inner, ' ');
  }
  if (channels.length !== 3) return null;
  if (name.startsWith('hsl')) return null;
  const ch = channels.map((c) => (c.trim().endsWith('%') ? evalNumber(c) : evalNumber(c) / 255));
  return [...ch, evalNumber(alpha)];
}

/** Tokenises a resolved value: colours become rgba arrays, numbers become numbers. */
export function canon(value, currentColour) {
  const tokens = [];
  const v = value.trim().replace(/\s+/g, ' ');
  let i = 0;
  let text = '';
  const flush = () => {
    for (const part of text.split(/([\s,()/])/)) {
      const t = part.trim();
      if (!t) continue;
      const num = t.match(/^(-?\d*\.?\d+(?:e[+-]?\d+)?)([a-z%]*)$/i);
      if (num) tokens.push({ n: parseFloat(num[1]), u: num[2].toLowerCase() });
      else tokens.push(t.toLowerCase());
    }
    text = '';
  };
  while (i < v.length) {
    const rest = v.slice(i);
    const fn = rest.match(/^(rgba?|hsla?)\(/i);
    const prevOk = i === 0 || /[\s,(]/.test(v[i - 1]);
    if (fn && prevOk) {
      const close = findClose(v, i + fn[1].length);
      const parsed =
        close === -1 ? null : parseColourFn(fn[1].toLowerCase(), v.slice(i + fn[0].length, close));
      if (parsed) {
        flush();
        tokens.push({ c: parsed });
        i = close + 1;
        continue;
      }
    }
    const hex = rest.match(/^#([0-9a-f]{3,8})\b/i);
    if (hex && prevOk) {
      flush();
      tokens.push({ c: hexToRgba(hex[0]) });
      i += hex[0].length;
      continue;
    }
    const word = rest.match(/^[a-z-]+/i);
    if (word && prevOk && !/[a-z0-9-]/i.test(v[i + word[0].length] || '')) {
      const w = word[0].toLowerCase();
      if (w === 'currentcolor' && currentColour) {
        flush();
        tokens.push(...currentColour);
        i += word[0].length;
        continue;
      }
      if (NAMED[w]) {
        flush();
        tokens.push({ c: NAMED[w] });
        i += word[0].length;
        continue;
      }
    }
    // calc()/min()/max() of plain numbers collapse to a number.
    const math = rest.match(/^(calc|min|max)\(/i);
    if (math && prevOk) {
      const close = findClose(v, i + math[1].length);
      if (close !== -1) {
        try {
          const n = evalNumber(v.slice(i, close + 1));
          flush();
          tokens.push({ n, u: '' });
          i = close + 1;
          continue;
        } catch {
          // Not a pure number (it has units): keep it as text.
        }
      }
    }
    text += v[i];
    i++;
  }
  flush();
  return tokens;
}

export function tokensEqual(a, b, tol = TOLERANCE) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (typeof x === 'string' || typeof y === 'string') {
      if (x !== y) return false;
    } else if (x.c || y.c) {
      if (!x.c || !y.c) return false;
      for (let k = 0; k < 4; k++) if (Math.abs(x.c[k] - y.c[k]) > tol) return false;
    } else if (x.u !== y.u || Math.abs(x.n - y.n) > tol) return false;
  }
  return true;
}

export function showTokens(tokens) {
  return tokens
    .map((t) => {
      if (typeof t === 'string') return t;
      if (t.c)
        return `rgba(${t.c
          .slice(0, 3)
          .map((x) => +(x * 255).toFixed(1))
          .join(' ')} / ${+t.c[3].toFixed(4)})`;
      return `${+t.n.toFixed(4)}${t.u}`;
    })
    .join(' ');
}

function isColourWord(t) {
  return /^(#|rgba?\(|hsla?\()/i.test(t) || /^(transparent|currentcolor|white|black|inherit)$/i.test(t);
}

/** Pulls one longhand out of a resolved shorthand value. */
function fromShorthand(longhand, shorthand, value) {
  if (shorthand === 'background') {
    const layers = splitTop(value, ',');
    if (longhand === 'background-color') {
      const last = splitTop(layers[layers.length - 1], ' ');
      return last.find(isColourWord) || 'transparent';
    }
    const images = layers
      .map((l) =>
        splitTop(l, ' ')
          .filter((t) => /^(url\(|[a-z-]*gradient\()/i.test(t))
          .join(' '),
      )
      .filter(Boolean);
    return images.length ? images.join(', ') : 'none';
  }
  if (shorthand === 'border-color') {
    const parts = splitTop(value, ' ');
    const [t, r = t, b = t, l = r] = parts;
    return {
      'border-top-color': t,
      'border-right-color': r,
      'border-bottom-color': b,
      'border-left-color': l,
    }[longhand];
  }
  return splitTop(value, ' ').find(isColourWord) || 'currentcolor';
}

// ---------------------------------------------------------------------------------------
// Cascade

function winnerFor(prop, matched) {
  const props = [prop, ...(SHORTHANDS[prop] || [])];
  for (const [logical, physical] of Object.entries(LOGICAL)) if (physical === prop) props.push(logical);
  let best = null;
  for (const m of matched) if (props.includes(m.decl.prop) && beats(m, best)) best = m;
  return best;
}

function beats(m, best) {
  if (!best) return true;
  if (m.decl.important !== best.decl.important) return m.decl.important;
  const s = compareSpec(m.spec, best.spec);
  if (s !== 0) return s > 0;
  return m.decl.order > best.decl.order;
}

function computeNode(sheet, target, env, parentStyle) {
  const node = target.pseudo ? target.element : target;
  const matched = [];
  for (const { ri, si } of candidateEntries(sheet, node)) {
    const rule = sheet.rules[ri];
    if (rule.media.length && !rule.media.every((m) => mediaMatches(m, env))) continue;
    const sel = rule.selectors[si];
    if (!selectorMatches(sel, target)) continue;
    for (const decl of rule.decls) matched.push({ decl, spec: sel.spec, selector: sel.text });
  }

  // Winning declaration per property.
  const winners = new Map();
  for (const m of matched) {
    const cur = winners.get(m.decl.prop);
    if (beats(m, cur)) winners.set(m.decl.prop, m);
  }

  // Custom properties: inherited, then own declarations with var() resolved on this element.
  const parentCustoms = parentStyle ? parentStyle.customs : new Map();
  const customs = new Map(parentCustoms);
  const resolving = new Set();
  const resolved = new Map();
  const lookup = (name) => {
    if (winners.has(name)) {
      if (resolved.has(name)) return resolved.get(name);
      if (resolving.has(name)) return INVALID;
      resolving.add(name);
      const raw = winners.get(name).decl.value;
      let v;
      if (/^\s*(inherit|unset)\s*$/i.test(raw)) v = parentCustoms.get(name);
      else if (/^\s*initial\s*$/i.test(raw)) v = undefined;
      else v = substitute(raw, lookup);
      resolving.delete(name);
      resolved.set(name, v === INVALID ? undefined : v);
      return resolved.get(name);
    }
    return parentCustoms.get(name);
  };
  for (const name of winners.keys()) if (name.startsWith('--')) customs.set(name, lookup(name));

  const style = { customs, values: {}, raw: {} };
  const resolveProp = (prop) => {
    if (prop.startsWith('--')) {
      const v = customs.get(prop);
      return v === undefined ? '(unset)' : v;
    }
    const w = winnerFor(prop, matched);
    let value;
    if (w) {
      let v = substitute(w.decl.value, lookup);
      // A value that is empty after var() substitution is invalid at computed-value time.
      if (v !== INVALID && v.trim() === '') v = INVALID;
      if (v !== INVALID && w.decl.prop !== prop && !LOGICAL[w.decl.prop])
        v = fromShorthand(prop, w.decl.prop, v);
      if (v === INVALID || /^\s*unset\s*$/i.test(v)) v = INHERITED.has(prop) ? 'inherit' : 'initial';
      value = v.trim();
      style.raw[prop] = `${w.selector} { ${w.decl.prop}: ${w.decl.value} }`;
    } else value = INHERITED.has(prop) ? 'inherit' : 'initial';
    if (value === 'inherit') return parentStyle ? parentStyle.values[prop] : INITIAL[prop];
    if (value === 'initial') return INITIAL[prop];
    return value;
  };
  // `color` first: currentcolor in every other property resolves to it.
  style.values.color = resolveProp('color');
  for (const prop of COMPARED) if (prop !== 'color') style.values[prop] = resolveProp(prop);
  return style;
}

function canonStyle(style) {
  const colour = canon(style.values.color === 'currentcolor' ? 'black' : style.values.color, null);
  const out = {};
  for (const prop of COMPARED) out[prop] = canon(style.values[prop] ?? '', colour);
  return out;
}

// ---------------------------------------------------------------------------------------
// Synthetic elements from the markup

async function listSourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listSourceFiles(full)));
    else if (/\.(astro|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Reads a balanced {...} block starting at `start` (which is '{'); returns the end index (exclusive). */
function readBraces(text, start) {
  let depth = 0;
  let i = start;
  const stack = [];
  while (i < text.length) {
    const ch = text[i];
    const mode = stack[stack.length - 1];
    if (mode === '`') {
      if (ch === '\\') i += 2;
      else if (ch === '`') {
        stack.pop();
        i++;
      } else if (ch === '$' && text[i + 1] === '{') {
        stack.push('${');
        depth++;
        i += 2;
      } else i++;
      continue;
    }
    if (mode === "'" || mode === '"') {
      if (ch === '\\') i += 2;
      else {
        if (ch === mode) stack.pop();
        i++;
      }
      continue;
    }
    if (ch === '`' || ch === "'" || ch === '"') {
      stack.push(ch);
      i++;
      continue;
    }
    if (ch === '{') {
      depth++;
      if (mode === '${') stack.push('{');
      i++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (mode === '${' || mode === '{') stack.pop();
      i++;
      if (depth === 0 && !stack.length) return i;
      continue;
    }
    i++;
  }
  return text.length;
}

/** All string literals (static text of quotes and template literals) inside a JS expression. */
function literalsIn(expr) {
  const out = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < expr.length && expr[j] !== ch) j += expr[j] === '\\' ? 2 : 1;
      out.push(expr.slice(i + 1, j));
      i = j + 1;
    } else if (ch === '`') {
      const end = templateEnd(expr, i);
      out.push(...templateAlternatives(expr.slice(i + 1, end - 1)));
      i = end;
    } else i++;
  }
  return out;
}

function templateEnd(text, start) {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') i += 2;
    else if (text[i] === '`') return i + 1;
    else if (text[i] === '$' && text[i + 1] === '{') i = readBraces(text, i + 1);
    else i++;
  }
  return text.length;
}

/** Splits template text into static text and ${} expressions. */
function splitTemplate(body) {
  const parts = [];
  let i = 0;
  let text = '';
  while (i < body.length) {
    if (body[i] === '$' && body[i + 1] === '{') {
      const end = readBraces(body, i + 1);
      parts.push({ text });
      text = '';
      parts.push({ expr: body.slice(i + 2, end - 1) });
      i = end;
    } else {
      text += body[i];
      i++;
    }
  }
  parts.push({ text });
  return parts;
}

/** Class-list alternatives for a template body: static text plus each expression's literals. */
function templateAlternatives(body) {
  const parts = splitTemplate(body);
  const base = parts
    .filter((p) => 'text' in p)
    .map((p) => p.text)
    .join(' ');
  const exprs = parts.filter((p) => 'expr' in p).map((p) => [...literalsIn(p.expr), '']);
  return combine(base, exprs);
}

const MAX_COMBOS = 128;

function combine(base, exprs) {
  const total = exprs.reduce((n, alts) => n * alts.length, 1);
  if (total <= MAX_COMBOS) {
    let lists = [base];
    for (const alts of exprs) lists = lists.flatMap((l) => alts.map((a) => `${l} ${a}`));
    return lists;
  }
  const out = [base];
  for (const alts of exprs) for (const a of alts) out.push(`${base} ${a}`);
  return out;
}

/** Class-list alternatives for a class / class:list attribute value. */
function classValueAlternatives(name, raw) {
  if (raw.startsWith('{')) {
    const expr = raw.slice(1, -1).trim();
    if (name === 'class:list') {
      const inner = expr.replace(/^\[/, '').replace(/\]$/, '');
      const items = splitTopJs(inner);
      const base = [];
      const exprs = [];
      for (const item of items) {
        const t = item.trim();
        if (/^(['"])[^'"]*\1$/.test(t)) base.push(t.slice(1, -1));
        else if (t.startsWith('{')) for (const lit of literalsIn(t)) exprs.push([lit, '']);
        else if (t) exprs.push([...literalsIn(t), '']);
      }
      return combine(base.join(' '), exprs);
    }
    if (expr.startsWith('`') && templateEnd(expr, 0) === expr.length)
      return templateAlternatives(expr.slice(1, -1));
    return [...literalsIn(expr), ''];
  }
  const body = raw.replace(/^(['"])([\s\S]*)\1$/, '$2');
  return body.includes('${') ? templateAlternatives(body) : [body];
}

function splitTopJs(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      i = templateEnd(text, i);
      continue;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  out.push(text.slice(start));
  return out;
}

/** Scans a file for tags with class attributes, plus class strings used from script code. */
export function extractElements(text, file) {
  const found = [];
  const ATTR_NAME = /^[a-zA-Z_:@][\w:.\-@]*$/;
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    const m = text.slice(lt + 1, lt + 40).match(/^([a-zA-Z][\w-]*)/);
    if (!m) {
      i = lt + 1;
      continue;
    }
    const tag = m[1];
    let j = lt + 1 + tag.length;
    const attrs = {};
    const classAttrs = [];
    const dynamicAttrs = [];
    let ok = false;
    while (j < text.length) {
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '>' || (text[j] === '/' && text[j + 1] === '>')) {
        ok = true;
        break;
      }
      if (text[j] === '{') {
        j = readBraces(text, j);
        continue;
      }
      const nm = text.slice(j).match(/^[^\s=>/]+/);
      if (!nm || !ATTR_NAME.test(nm[0])) break;
      const name = nm[0];
      j += name.length;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== '=') {
        attrs[name.toLowerCase()] = '';
        continue;
      }
      j++;
      while (j < text.length && /\s/.test(text[j])) j++;
      let raw;
      if (text[j] === '"' || text[j] === "'") {
        const q = text[j];
        let k = j + 1;
        while (k < text.length && text[k] !== q) {
          if (text[k] === '$' && text[k + 1] === '{') k = readBraces(text, k + 1);
          else k++;
        }
        raw = text.slice(j, k + 1);
        j = k + 1;
      } else if (text[j] === '{') {
        const end = readBraces(text, j);
        raw = text.slice(j, end);
        j = end;
      } else {
        const um = text.slice(j).match(/^[^\s>]+/);
        raw = um ? um[0] : '';
        j += raw.length;
      }
      if (name === 'class' || name === 'class:list' || name === 'className') classAttrs.push([name, raw]);
      else if (/^(['"])[^${}]*\1$/.test(raw)) attrs[name.toLowerCase()] = raw.slice(1, -1);
      else dynamicAttrs.push(name.toLowerCase());
    }
    if (ok && classAttrs.length) {
      for (const [name, raw] of classAttrs)
        for (const list of classValueAlternatives(name, raw))
          found.push({ file, tag: tag.toLowerCase(), attrs, dynamicAttrs, list });
    }
    i = ok ? j : lt + 1;
  }

  // Script code: .ts files whole; .astro files only their frontmatter and <script> blocks.
  const code = file.endsWith('.astro') ? astroScriptCode(text) : text;
  // Class strings set from script code: className = '...', classList.add/toggle/remove('...').
  const scriptPatterns = [
    /\.className\s*=\s*/g,
    /\.classList\.(?:add|toggle|remove|replace)\(/g,
    /\bclass(?:Name)?\s*:\s*/g,
  ];
  for (const re of scriptPatterns) {
    for (const mm of code.matchAll(re)) {
      const start = mm.index + mm[0].length;
      const end = Math.min(code.length, start + 400);
      const slice = code.slice(start, end);
      const stop = slice.search(/[;\n]/);
      for (const lit of literalsIn(stop === -1 ? slice : slice.slice(0, stop)))
        found.push({ file, tag: 'div', attrs: {}, list: lit, scripted: true });
    }
  }
  // Any other string literal that reads as a class list (lookup tables in src/lib and scripts).
  for (const lit of literalsIn(stripComments(code)))
    found.push({ file, tag: 'div', attrs: {}, list: lit, loose: true, scripted: true });
  return found;
}

function astroScriptCode(text) {
  const parts = [];
  const fm = text.match(/^\s*---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) parts.push(fm[1]);
  for (const m of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) parts.push(m[1]);
  return parts.join('\n;\n');
}

/** Attribute names that script code can set or change at runtime. */
export function dynamicAttributeNames(text) {
  const out = new Set();
  const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  for (const m of text.matchAll(/(?:set|toggle|remove)Attribute\(\s*['"`]([\w-]+)/g))
    out.add(m[1].toLowerCase());
  for (const m of text.matchAll(/\.dataset\.(\w+)\s*=(?!=)/g)) out.add(`data-${kebab(m[1])}`);
  for (const m of text.matchAll(/\.dataset\[\s*['"`](\w+)['"`]\s*\]\s*=(?!=)/g))
    out.add(`data-${kebab(m[1])}`);
  for (const m of text.matchAll(/\.(open|disabled|checked|hidden|selected)\s*=(?!=)/g)) out.add(m[1]);
  return out;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** Loads the swap list; returns per-file reverse mappings (after classes -> before classes). */
export async function loadSwaps() {
  try {
    return JSON.parse(await readFile(path.join(FIXTURE_DIR, 'swaps.json'), 'utf8')).swaps || [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function reverseSwap(classes, file, swaps) {
  let out = [...classes];
  const relevant = swaps
    .filter((s) => s.file === file)
    .map((s) => ({ old: s.old.split(/\s+/).filter(Boolean), new: s.new.split(/\s+/).filter(Boolean) }))
    .sort((a, b) => b.new.length - a.new.length);
  for (const s of relevant) {
    if (s.new.every((c) => out.includes(c))) {
      out = out.filter((c) => !s.new.includes(c));
      out.push(...s.old);
    }
  }
  return out;
}

/** Every synthetic element: class lists from the markup, mapped for the before and after runs. */
export async function collectElements({ beforeSheet, afterSheet, swaps }) {
  const files = await listSourceFiles(path.join(ROOT, 'src'));
  const known = new Set([...beforeSheet.classes, ...afterSheet.classes]);
  const fixedNames = new Set(swaps.flatMap((s) => s.new.split(/\s+/)));
  const byKey = new Map();
  const texts = [];
  for (const full of files) {
    const file = path.relative(ROOT, full).replace(/\\/g, '/');
    if (file === 'src/lib/worldMap.ts') continue;
    texts.push([file, await readFile(full, 'utf8')]);
  }
  const runtimeAttrs = new Set();
  for (const [, text] of texts) for (const a of dynamicAttributeNames(text)) runtimeAttrs.add(a);
  for (const [file, text] of texts) {
    for (const el of extractElements(text, file)) {
      const tokens = el.list.split(/\s+/).filter(Boolean);
      const after = [...new Set(tokens.filter((t) => known.has(t)))].sort();
      if (el.loose && (!after.length || after.length < tokens.length / 2)) continue;
      if (!after.length && !Object.keys(el.attrs).length) continue;
      const before = [...new Set(reverseSwap(after, file, swaps))].sort();
      const attrs = Object.fromEntries(
        Object.entries(el.attrs).filter(([k]) => /^(type|role|open|disabled|hidden|data-|aria-)/.test(k)),
      );
      const key = `${el.tag}|${JSON.stringify(attrs)}|${after.join(' ')}|${before.join(' ')}`;
      if (!byKey.has(key))
        byKey.set(key, {
          tag: el.tag,
          attrs,
          after,
          before,
          files: new Set(),
          dynamicAttrs: new Set(),
          scripted: false,
        });
      const entry = byKey.get(key);
      entry.files.add(file);
      for (const a of el.dynamicAttrs || []) entry.dynamicAttrs.add(a);
      if (el.scripted) entry.scripted = true;
    }
  }
  // Attributes a scenario may add: ones that change at runtime. Elements built in script code
  // carry no markup, so any attribute their rules test may be present.
  for (const entry of byKey.values()) {
    entry.canHaveAttr = (name) =>
      entry.scripted ||
      name.startsWith('aria-') ||
      ['open', 'disabled', 'checked', 'hidden', 'selected'].includes(name) ||
      entry.dynamicAttrs.has(name) ||
      runtimeAttrs.has(name);
  }
  // The body itself (its colours come from `body { @apply ... }`, not from a class).
  byKey.set('body', {
    tag: 'body',
    attrs: {},
    after: [],
    before: [],
    files: new Set(['src/layouts/Layout.astro']),
    isBody: true,
  });
  return [...byKey.values()].map((e) => ({
    ...e,
    files: [...e.files].sort(),
    usesFixed: e.after.some((c) => fixedNames.has(c)),
  }));
}

// ---------------------------------------------------------------------------------------
// Scenarios (states and ancestors) implied by the rules that can match an element

function relaxedMatch(compound, el) {
  if (compound.tag && compound.tag !== el.tag) return false;
  if (compound.ids.length) return false;
  for (const c of compound.classes) if (!el.classes.includes(c)) return false;
  for (const a of compound.attrs)
    if (a.name === 'class' && !matchAttr({ classes: el.classes, attrs: {} }, a)) return false;
  return true;
}

function compoundSpec(compound) {
  const attrs = {};
  for (const a of compound.attrs) {
    if (a.name === 'class') continue;
    attrs[a.name] = a.op === '=' || a.op === '~=' ? a.value : (a.value ?? '');
  }
  const states = compound.pseudos.map((p) => p.name).filter((n) => INTERACTIVE.has(n));
  return { tag: compound.tag || 'div', classes: compound.classes.filter(Boolean), attrs, states };
}

function scenarioFromSelector(sel, el) {
  const last = sel.compounds[sel.compounds.length - 1];
  if (!last.tag && !last.classes.length && !last.attrs.length) return null;
  if (!relaxedMatch(last, el)) return null;
  const self = compoundSpec(last);
  const scenario = {
    states: self.states,
    attrs: {},
    pseudo: last.pseudoElement,
    ancestors: [],
    siblings: [],
  };
  for (const [k, v] of Object.entries(self.attrs)) {
    if (k in el.attrs) {
      if (el.attrs[k] !== v && v !== '') return null;
    } else if (el.canHaveAttr && !el.canHaveAttr(k)) return null;
    else scenario.attrs[k] = v;
  }
  // Walk leftwards building ancestors and previous siblings.
  let host = 'self';
  for (let i = sel.compounds.length - 2; i >= 0; i--) {
    const comp = sel.compounds[i];
    const comb = sel.combinators[i];
    if (comp.pseudoElement) return null;
    if (comp.classes.includes('light') || comp.tag === 'html' || comp.pseudos.some((p) => p.name === 'root'))
      continue;
    if (comp.tag === 'body' && !comp.classes.length) continue;
    const spec = compoundSpec(comp);
    if (comb === '~' || comb === '+') {
      if (host === 'self') scenario.siblings.unshift(spec);
      else scenario.ancestors[0].siblings = [spec];
    } else {
      scenario.ancestors.unshift({ ...spec, siblings: [] });
      host = 'ancestor';
    }
  }
  return scenario;
}

function scenarioKey(s) {
  return JSON.stringify(s);
}

export function scenariosFor(el, sheets) {
  const out = new Map();
  const rest = { states: [], attrs: {}, pseudo: null, ancestors: [], siblings: [] };
  out.set(scenarioKey(rest), rest);
  for (const [sheet, classes] of sheets) {
    const probe = { tag: el.tag, classes, attrs: el.attrs, canHaveAttr: el.canHaveAttr };
    for (const { ri, si } of candidateEntries(sheet, probe)) {
      const rule = sheet.rules[ri];
      if (
        !rule.decls.some(
          (d) => d.prop.startsWith('--') || COMPARED.includes(d.prop) || SHORTHAND_SET.has(d.prop),
        )
      )
        continue;
      const s = scenarioFromSelector(rule.selectors[si], probe);
      if (s) out.set(scenarioKey(s), s);
    }
    // Children of a divide-* utility take its border colour.
    if (classes.some((c) => /(^|:)divide-/.test(c))) {
      const d = { states: [], attrs: {}, pseudo: null, ancestors: [], siblings: [], divideChild: true };
      out.set(scenarioKey(d), d);
    }
  }
  return [...out.values()];
}

const SHORTHAND_SET = new Set(Object.values(SHORTHANDS).flat());

// ---------------------------------------------------------------------------------------
// Evaluation

function makeNode(spec, parent) {
  return {
    tag: spec.tag,
    classes: spec.classes || [],
    attrs: spec.attrs || {},
    states: new Set(spec.states || []),
    parent,
    prev: [],
  };
}

function withFocus(states) {
  const s = new Set(states);
  if (s.has('focus-visible')) s.add('focus');
  return s;
}

/** Builds the synthetic DOM for one element + scenario and returns the target's style. */
function evaluate(sheet, el, classes, scenario, theme, env, cache) {
  const htmlKey = `${theme}|${env.width}`;
  let base = cache.get(htmlKey);
  if (!base) {
    const html = makeNode({ tag: 'html', classes: theme === 'light' ? ['light'] : [] }, null);
    const htmlStyle = computeNode(sheet, html, env, null);
    const body = makeNode({ tag: 'body' }, html);
    const bodyStyle = computeNode(sheet, body, env, htmlStyle);
    base = { html, htmlStyle, body, bodyStyle };
    cache.set(htmlKey, base);
  }
  if (el.isBody) return base.bodyStyle;
  let parent = base.body;
  let parentStyle = base.bodyStyle;
  for (const a of scenario.ancestors) {
    const node = makeNode({ ...a, states: [...withFocus(a.states)] }, parent);
    for (const s of a.siblings || [])
      node.prev.push(makeNode({ ...s, states: [...withFocus(s.states)] }, parent));
    parentStyle = computeNode(sheet, node, env, parentStyle);
    parent = node;
  }
  const attrs = { ...el.attrs, ...scenario.attrs };
  const element = makeNode({ tag: el.tag, classes, attrs, states: [...withFocus(scenario.states)] }, parent);
  for (const s of scenario.siblings)
    element.prev.push(makeNode({ ...s, states: [...withFocus(s.states)] }, parent));
  const elementStyle = computeNode(sheet, element, env, parentStyle);
  if (scenario.pseudo) return computeNode(sheet, { pseudo: scenario.pseudo, element }, env, elementStyle);
  if (scenario.divideChild) {
    const first = makeNode({ tag: 'div' }, element);
    const child = makeNode({ tag: 'div' }, element);
    child.prev.push(first);
    return computeNode(sheet, child, env, elementStyle);
  }
  return elementStyle;
}

/** Resolved, normalised values for one element in every scenario (for debugging a difference). */
export function inspectElement(css, el) {
  const sheet = buildSheet(css);
  const cache = new Map();
  const out = [];
  for (const scenario of scenariosFor(el, [[sheet, el.classes]])) {
    for (const theme of THEMES) {
      const style = canonStyle(
        evaluate(sheet, { ...el, isBody: el.isBody }, el.classes, scenario, theme, { width: 1600 }, cache),
      );
      const values = Object.fromEntries(
        Object.entries(style)
          .filter(([, t]) => t.length)
          .map(([p, t]) => [p, showTokens(t)]),
      );
      out.push({ scenario: describeScenario(scenario), theme, values });
    }
  }
  return out;
}

function describeScenario(s) {
  const parts = [];
  if (s.states.length) parts.push(s.states.map((x) => `:${x}`).join(''));
  for (const [k, v] of Object.entries(s.attrs)) parts.push(`[${k}=${v}]`);
  if (s.pseudo) parts.push(`::${s.pseudo}`);
  if (s.divideChild) parts.push(' > child');
  const anc = s.ancestors.map(
    (a) =>
      `${a.tag}${a.classes.map((c) => `.${c}`).join('')}${Object.keys(a.attrs)
        .map((k) => `[${k}]`)
        .join('')}${a.states.map((x) => `:${x}`).join('')}`,
  );
  const sib = s.siblings.map(
    (a) => `${a.classes.map((c) => `.${c}`).join('')}${a.states.map((x) => `:${x}`).join('')} ~ `,
  );
  return `${anc.length ? `${anc.join(' ')} ` : ''}${sib.join('')}${parts.join('') || '(rest)'}`;
}

/**
 * Compares every synthetic element in every scenario, theme and width.
 * Returns { checked, elements, differences: [...] }.
 */
export async function compareThemes({ beforeCss, afterCss, swaps }) {
  const beforeSheet = buildSheet(beforeCss);
  const afterSheet = buildSheet(afterCss);
  const elements = await collectElements({ beforeSheet, afterSheet, swaps });
  const differences = [];
  let checked = 0;
  const beforeCache = new Map();
  const afterCache = new Map();
  for (const el of elements) {
    const scenarios = scenariosFor(el, [
      [beforeSheet, el.before],
      [afterSheet, el.after],
    ]);
    for (const scenario of scenarios) {
      for (const theme of THEMES) {
        for (const width of WIDTHS) {
          const env = { width };
          const b = canonStyle(evaluate(beforeSheet, el, el.before, scenario, theme, env, beforeCache));
          const a = canonStyle(evaluate(afterSheet, el, el.after, scenario, theme, env, afterCache));
          checked++;
          for (const prop of COMPARED) {
            if (!tokensEqual(b[prop], a[prop])) {
              differences.push({
                element: `<${el.tag}${Object.entries(el.attrs)
                  .map(([k, v]) => ` ${k}="${v}"`)
                  .join('')}> ${el.after.join(' ')}`,
                before: el.before.join(' '),
                files: el.files,
                scenario: describeScenario(scenario),
                theme,
                width,
                prop,
                beforeValue: showTokens(b[prop]),
                afterValue: showTokens(a[prop]),
              });
            }
          }
        }
      }
    }
  }
  return { elements: elements.length, checked, differences };
}

/** BR2.2: every rule whose selector starts with `.light` declares only custom properties or color-scheme. */
export function lightRuleViolations(css) {
  const out = [];
  postcss.parse(css).walkRules((rule) => {
    const lightSelectors = rule.selectors.filter((s) => s.trim().startsWith('.light'));
    if (!lightSelectors.length) return;
    // Rules generated from an arbitrary `[.light_&]:` variant in the markup toggle layout (display), not colour.
    if (lightSelectors.every((s) => /^\.light \.\\\[\\\.light_\\&\\\]\\:/.test(s.trim()))) return;
    for (const node of rule.nodes || []) {
      if (node.type === 'decl' && !node.prop.startsWith('--') && node.prop !== 'color-scheme')
        out.push(`${rule.selector.replace(/\s+/g, ' ')} { ${node.prop}: ${node.value} }`);
    }
  });
  return out;
}

/**
 * Checks tests/fixtures/theme/swaps.json against the inventory and the markup: every utility the
 * inventory says needs the fixed family has its swap in each file that uses it, and every swap's
 * new classes are present in its file. Returns a list of problems.
 */
export async function swapProblems() {
  const inventory = JSON.parse(await readFile(path.join(FIXTURE_DIR, 'inventory.json'), 'utf8'));
  const swaps = await loadSwaps();
  const problems = [];
  for (const row of inventory.utilities.filter((r) => r.needsFixed)) {
    for (const file of row.files) {
      if (!swaps.some((s) => s.file === file && s.old === row.class && s.new === row.fixed))
        problems.push(`missing swap: ${row.class} -> ${row.fixed} in ${file}`);
    }
  }
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  for (const s of swaps) {
    let text;
    try {
      text = await readFile(path.join(ROOT, s.file), 'utf8');
    } catch {
      problems.push(`swap names a missing file: ${s.file}`);
      continue;
    }
    for (const cls of s.new.split(/\s+/).filter(Boolean)) {
      if (!new RegExp(`(^|[\\s"'\`{}])${escape(cls)}(?=$|[\\s"'\`{}])`, 'm').test(text))
        problems.push(`swap not applied: ${cls} is not in ${s.file}`);
    }
  }
  return problems;
}

export async function loadBeforeCss() {
  return readFile(path.join(FIXTURE_DIR, 'before.css'), 'utf8');
}

/** Runs the full proof against the working tree. */
export async function runProof({ afterCss } = {}) {
  const [beforeCss, swaps] = await Promise.all([loadBeforeCss(), loadSwaps()]);
  const css = afterCss ?? (await compileCss());
  const result = await compareThemes({ beforeCss, afterCss: css, swaps });
  return { ...result, lightViolations: lightRuleViolations(css) };
}

export function formatDifferences(differences, limit = 40) {
  return differences
    .slice(0, limit)
    .map(
      (d) =>
        `${d.theme} @${d.width}px ${d.element}  ${d.scenario}\n    ${d.prop}: ${d.beforeValue}  ->  ${d.afterValue}   [${d.files.join(', ')}]`,
    )
    .join('\n');
}

async function main() {
  const t0 = Date.now();
  const result = await runProof();
  console.log(
    `Checked ${result.elements} synthetic elements, ${result.checked} element x scenario x theme x width combinations in ${((Date.now() - t0) / 1000).toFixed(1)}s.`,
  );
  if (result.differences.length) {
    console.log(
      `${result.differences.length} colour differences. First ones:\n${formatDifferences(result.differences)}`,
    );
  }
  if (result.lightViolations.length) {
    console.log(`${result.lightViolations.length} .light rules set a non-custom property:`);
    for (const v of result.lightViolations.slice(0, 40)) console.log(`  ${v}`);
  }
  process.exit(result.differences.length || result.lightViolations.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
