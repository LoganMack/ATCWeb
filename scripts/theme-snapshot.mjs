#!/usr/bin/env node
// Browser computed-colour snapshots for the theme-token change (spec W3.2; BR3.1).
//
// Usage:
//   node scripts/theme-snapshot.mjs --snippet
//       Prints a self-contained browser snippet. Evaluate it on a page (for example with the
//       in-app browser's JavaScript tool); it resolves to one page snapshot:
//         { url, keys: [...], props: [...], dark: [[...]], light: [[...]], rows: {...} }
//       Save the snapshots of one run as a JSON array (or { pages: { "<path>": snapshot } }).
//   node scripts/theme-snapshot.mjs --compare <before.json> <after.json>
//       Compares two runs page by page. Exits 1 on any colour difference, any missing or extra
//       element, or any row-count difference, and prints the first differences.
//   node scripts/theme-snapshot.mjs --self-test
//       Runs the built-in self-test of the comparison (it also runs before --compare).
//
// The snippet turns transitions and animations off, waits until no [data-fragment-url] or
// [aria-busy="true"] is left, then reads every element with `.light` removed and again with it
// added (two animation frames after each toggle), and restores the page's own theme. Elements
// are keyed by their nearest [data-*-results] container (or body), a tag and class signature,
// and an index within that container. Numbers are compared with a tolerance of 0.002.
// Exit codes: 0 identical, 1 differences, 2 usage or unreadable input.
// Dependency-free: Node 22 built-ins only.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// captureTheme runs in the browser, not in Node.
/* global document, getComputedStyle, requestAnimationFrame */

export const PROPS = [
  'color',
  'background-color',
  'background-image',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'text-decoration-color',
  'caret-color',
  'accent-color',
  'box-shadow',
  'text-shadow',
  'filter',
  'opacity',
  'fill',
  'stroke',
];

export const PSEUDO_PROPS = {
  '::placeholder': ['color', 'opacity'],
  '::file-selector-button': ['color', 'background-color', 'box-shadow'],
};

/** Runs in the page. Kept free of closures over module scope so it can be serialised. */
export async function captureTheme(props, pseudoProps) {
  const style = document.createElement('style');
  style.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
  document.head.appendChild(style);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const deadline = Date.now() + 30000;
  while (document.querySelector('[data-fragment-url], [aria-busy="true"]')) {
    if (Date.now() > deadline) throw new Error('fragments still loading after 30s');
    await sleep(100);
  }
  await frames();

  const containerOf = (el) => {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const attr = [...node.attributes].find((a) => /^data-.+-results$/.test(a.name));
      if (attr) return `${node.tagName.toLowerCase()}[${attr.name}]`;
    }
    return 'body';
  };
  const elements = [document.documentElement, document.body, ...document.body.querySelectorAll('*')].filter(
    (el) => el !== style,
  );
  const counters = new Map();
  const rows = {};
  const keys = elements.map((el) => {
    const container = el === document.documentElement || el === document.body ? 'root' : containerOf(el);
    const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
    const signature = `${el.tagName.toLowerCase()}${cls
      .split(/\s+/)
      .filter(Boolean)
      .sort()
      .map((c) => `.${c}`)
      .join('')}`;
    const counterKey = `${container} ${signature}`;
    const n = counters.get(counterKey) || 0;
    counters.set(counterKey, n + 1);
    rows[container] = rows[container] || { elements: 0, tr: 0, li: 0 };
    rows[container].elements++;
    if (el.tagName === 'TR') rows[container].tr++;
    if (el.tagName === 'LI') rows[container].li++;
    return `${counterKey} #${n}`;
  });

  const read = () =>
    elements.map((el) => {
      const cs = getComputedStyle(el);
      const values = props.map((p) => cs.getPropertyValue(p));
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        for (const [pseudo, list] of Object.entries(pseudoProps)) {
          const ps = getComputedStyle(el, pseudo);
          for (const p of list) values.push(`${pseudo} ${p}: ${ps.getPropertyValue(p)}`);
        }
      }
      return values;
    });

  const root = document.documentElement;
  const wasLight = root.classList.contains('light');
  root.classList.remove('light');
  await frames();
  const dark = read();
  root.classList.add('light');
  await frames();
  const light = read();
  root.classList.toggle('light', wasLight);
  style.remove();
  return { url: location.pathname + location.search, keys, props, dark, light, rows };
}

export function snippet() {
  return `(${captureTheme.toString()})(${JSON.stringify(PROPS)}, ${JSON.stringify(PSEUDO_PROPS)})`;
}

// --- Comparison ----------------------------------------------------------------------------

const TOLERANCE = 0.002;

function tokens(value) {
  return String(value)
    .trim()
    .split(/(-?\d*\.?\d+(?:e[+-]?\d+)?)/i)
    .filter((t) => t !== '');
}

export function valuesEqual(a, b) {
  if (a === b) return true;
  const x = tokens(a);
  const y = tokens(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    const nx = Number(x[i]);
    const ny = Number(y[i]);
    if (x[i].trim() !== '' && !Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (Math.abs(nx - ny) > TOLERANCE) return false;
    } else if (x[i].replace(/\s+/g, ' ') !== y[i].replace(/\s+/g, ' ')) return false;
  }
  return true;
}

function byUrl(data) {
  if (Array.isArray(data)) return new Map(data.map((s) => [s.url, s]));
  if (data && data.pages) return new Map(Object.entries(data.pages).map(([url, s]) => [s.url || url, s]));
  if (data && data.url) return new Map([[data.url, data]]);
  throw new Error('expected a snapshot, an array of snapshots, or { pages: { ... } }');
}

/** Returns a list of human-readable differences between two runs. */
export function compareRuns(before, after) {
  const diffs = [];
  const a = byUrl(before);
  const b = byUrl(after);
  for (const url of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(url);
    const y = b.get(url);
    if (!x || !y) {
      diffs.push(`${url}: page missing from the ${x ? 'after' : 'before'} run`);
      continue;
    }
    for (const container of new Set([...Object.keys(x.rows), ...Object.keys(y.rows)])) {
      const rx = JSON.stringify(x.rows[container] || null);
      const ry = JSON.stringify(y.rows[container] || null);
      if (rx !== ry) diffs.push(`${url}: row counts in ${container}: ${rx} -> ${ry}`);
    }
    const yIndex = new Map(y.keys.map((k, i) => [k, i]));
    const xKeys = new Set(x.keys);
    for (const k of y.keys) if (!xKeys.has(k)) diffs.push(`${url}: extra element ${k}`);
    x.keys.forEach((key, i) => {
      const j = yIndex.get(key);
      if (j === undefined) {
        diffs.push(`${url}: missing element ${key}`);
        return;
      }
      for (const theme of ['dark', 'light']) {
        const vx = x[theme][i];
        const vy = y[theme][j];
        const n = Math.max(vx.length, vy.length);
        for (let p = 0; p < n; p++) {
          if (!valuesEqual(vx[p] ?? '', vy[p] ?? '')) {
            const name = p < x.props.length ? x.props[p] : 'pseudo';
            diffs.push(`${url} [${theme}] ${key}\n    ${name}: ${vx[p]}  ->  ${vy[p]}`);
          }
        }
      }
    });
  }
  return diffs;
}

// --- Self-test -----------------------------------------------------------------------------

function selfTest() {
  const page = (light, rows = { body: { elements: 2, tr: 1, li: 0 } }) => ({
    url: '/x',
    keys: ['root html #0', 'body tr.text-white #0'],
    props: ['color', 'background-color'],
    dark: [
      ['rgb(255, 255, 255)', 'rgb(11, 11, 14)'],
      ['rgb(255, 255, 255)', 'rgba(0, 0, 0, 0)'],
    ],
    light: [
      ['rgb(17, 17, 20)', 'rgb(247, 247, 249)'],
      [light, 'rgba(0, 0, 0, 0)'],
    ],
    rows,
  });
  const cases = [
    [
      'identical runs',
      compareRuns([page('rgba(17, 17, 20, 0.28)')], [page('rgba(17, 17, 20, 0.28)')]).length === 0,
    ],
    [
      'float drift within tolerance',
      compareRuns([page('rgba(17, 17, 20, 0.28)')], [page('rgba(17, 17, 20, 0.2800001)')]).length === 0,
    ],
    [
      'a colour change is reported',
      compareRuns([page('rgba(17, 17, 20, 0.28)')], [page('rgba(17, 17, 20, 0.2)')]).length === 1,
    ],
    [
      'a row-count change is reported',
      compareRuns([page('x')], [page('x', { body: { elements: 2, tr: 2, li: 0 } })]).some((d) =>
        d.includes('row counts'),
      ),
    ],
    ['a missing page is reported', compareRuns([page('x')], []).length === 1],
    ['the snippet is an expression', /^\(async function captureTheme/.test(snippet())],
  ];
  const failed = cases.filter(([, ok]) => !ok);
  for (const [name] of failed) console.error(`self-test failed: ${name}`);
  if (failed.length) process.exit(2);
}

// --- CLI -----------------------------------------------------------------------------------

function usage(message) {
  if (message) console.error(message);
  console.error(
    'Usage: node scripts/theme-snapshot.mjs --snippet | --compare <before.json> <after.json> | --self-test',
  );
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--snippet') {
    console.log(snippet());
    return;
  }
  selfTest();
  if (args[0] === '--self-test') {
    console.log('theme-snapshot self-test passed');
    return;
  }
  if (args[0] !== '--compare' || args.length !== 3) usage();
  let before;
  let after;
  try {
    [before, after] = await Promise.all(
      args.slice(1).map(async (f) => JSON.parse(await readFile(f, 'utf8'))),
    );
  } catch (err) {
    usage(`Could not read the snapshots: ${err.message}`);
  }
  const diffs = compareRuns(before, after);
  const pages = byUrl(before).size;
  if (!diffs.length) {
    console.log(`Identical: ${pages} page(s), every element in both themes.`);
    return;
  }
  console.log(`${diffs.length} difference(s) across ${pages} page(s). First ones:`);
  for (const d of diffs.slice(0, 50)) console.log(`  ${d}`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
