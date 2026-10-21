#!/usr/bin/env node
// Theme inventory: the frozen "before" state for the theme-token change (FR11.1, NFR1).
//
// Usage:
//   node scripts/theme-inventory.mjs
//       Compiles today's tailwind.config.mjs and src/styles/global.css over the real content
//       globs and writes tests/fixtures/theme/before.css and tests/fixtures/theme/inventory.json.
//       Run it once, on the unchanged branch, and commit both files. They are the reference the
//       compile proof (scripts/theme-proof.mjs) compares against, so never regenerate them after
//       the theme change has started.
//
// The inventory lists every white, ink, brand, emerald-400 and red-300 utility (with variants)
// that the compile generates, every `.light` rule in global.css, which utilities a `.light` rule
// re-colours today, and the utilities that the token change would re-colour but that have no
// `.light` rule today: those must move to the fixed colour family so they stay constant.

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import tailwindcss from 'tailwindcss';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'theme');
const posix = (p) => p.replace(/\\/g, '/');

/**
 * Compiles global.css with the project's Tailwind config over the real content globs.
 * The config is imported fresh (cache-busted) so a test run sees the working tree's config.
 */
export async function compileCss() {
  const configUrl = `${pathToFileURL(path.join(ROOT, 'tailwind.config.mjs')).href}?t=${Date.now()}`;
  const { default: config } = await import(configUrl);
  const content = config.content.map((glob) => posix(path.join(ROOT, glob)));
  const cssPath = path.join(ROOT, 'src', 'styles', 'global.css');
  const css = await readFile(cssPath, 'utf8');
  const result = await postcss([tailwindcss({ ...config, content })]).process(css, { from: cssPath });
  return result.css;
}

/** Last segment of a Tailwind class after its variants (`hover:file:text-white/60` -> `text-white/60`). */
export function utilityPart(cls) {
  let depth = 0;
  let last = 0;
  for (let i = 0; i < cls.length; i++) {
    const ch = cls[i];
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === ':' && depth === 0) last = i + 1;
  }
  return cls.slice(last);
}

const COLOUR_UTILITY =
  /-(white|brand-(?:primary|secondary|tertiary|blue|pink|gold|ink)|emerald-400|red-300)(?:\/|$)/;

/** Whether the planned Tailwind settings make this utility follow the theme. */
export function isTokenised(cls) {
  const u = utilityPart(cls).replace(/^-/, '');
  if (/-white(?:\/|$)/.test(u)) return true;
  if (/-brand-ink(?:\/|$)/.test(u)) return true;
  if (/^text-brand-(?:blue|primary|pink|gold)(?:\/|$)/.test(u)) return true;
  if (/^text-(?:emerald-400|red-300)(?:\/|$)/.test(u)) return true;
  return false;
}

/** The fixed-family name for a class (variants kept), or null when the family has no equivalent. */
export function fixedName(cls) {
  const u = utilityPart(cls);
  const prefix = cls.slice(0, cls.length - u.length);
  let fixed = null;
  if (/-white(?:\/|$)/.test(u)) fixed = u.replace(/-white(?=\/|$)/, '-fixed-white');
  else if (/-brand-ink(?:\/|$)/.test(u)) fixed = u.replace(/-brand-ink(?=\/|$)/, '-fixed-ink');
  else if (/-brand-(?:primary|secondary|tertiary|blue|pink|gold)(?:\/|$)/.test(u))
    fixed = u.replace(/-brand-(\w+)(?=\/|$)/, '-brand-fixed-$1');
  return fixed ? prefix + fixed : null;
}

/** Class names a selector targets, including `[class~='x']` attribute matches. */
export function selectorClasses(selector) {
  const out = new Set();
  selectorParser((root) => {
    root.walkClasses((node) => out.add(node.value));
    root.walkAttributes((node) => {
      if (node.attribute === 'class' && node.operator === '~=' && node.value) out.add(node.value);
    });
  }).processSync(selector);
  return [...out];
}

function walkStyleRules(cssRoot, visit) {
  cssRoot.walkRules((rule) => {
    if (rule.parent && rule.parent.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
    visit(rule);
  });
}

function declarations(rule) {
  return rule.nodes
    .filter((n) => n.type === 'decl')
    .map((d) => `${d.prop}: ${d.value}${d.important ? ' !important' : ''}`);
}

async function listSourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listSourceFiles(full)));
    else if (/\.(astro|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Builds the inventory object from a compiled CSS string and the markup under src/. */
export async function buildInventory(css) {
  const cssRoot = postcss.parse(css);
  const utilities = new Map();
  const lightRules = [];

  walkStyleRules(cssRoot, (rule) => {
    const isLight = rule.selectors.some((s) => s.trim().startsWith('.light'));
    if (isLight) {
      lightRules.push({
        selector: rule.selector.replace(/\s+/g, ' '),
        declarations: declarations(rule),
        classes: rule.selectors.flatMap((s) => selectorClasses(s)).filter((c) => c !== 'light'),
      });
      return;
    }
    for (const sel of rule.selectors) {
      for (const cls of selectorClasses(sel)) {
        if (!COLOUR_UTILITY.test(utilityPart(cls))) continue;
        if (!utilities.has(cls)) utilities.set(cls, { class: cls, declarations: declarations(rule) });
      }
    }
  });

  const lightClasses = new Set(lightRules.flatMap((r) => r.classes));
  const files = await listSourceFiles(path.join(ROOT, 'src'));
  const sources = await Promise.all(
    files.map(async (f) => [posix(path.relative(ROOT, f)), await readFile(f, 'utf8')]),
  );

  const rows = [...utilities.values()]
    .sort((a, b) => a.class.localeCompare(b.class))
    .map((u) => {
      const tokenised = isTokenised(u.class);
      const hasLightRule = lightClasses.has(u.class);
      const needsFixed = tokenised && !hasLightRule;
      const re = new RegExp(
        `(^|[\\s"'\`{}])${u.class.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?=$|[\\s"'\`{}])`,
        'm',
      );
      return {
        ...u,
        tokenised,
        hasLightRule,
        needsFixed,
        fixed: needsFixed ? fixedName(u.class) : null,
        files: sources.filter(([, text]) => re.test(text)).map(([f]) => f),
      };
    });

  return {
    generatedFrom:
      'tailwind.config.mjs + src/styles/global.css over src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}',
    counts: {
      utilities: rows.length,
      withLightRule: rows.filter((r) => r.hasLightRule).length,
      withoutLightRule: rows.filter((r) => !r.hasLightRule).length,
      tokenised: rows.filter((r) => r.tokenised).length,
      needsFixed: rows.filter((r) => r.needsFixed).length,
      lightRules: lightRules.length,
    },
    utilities: rows,
    lightRules,
  };
}

async function main() {
  const css = await compileCss();
  const inventory = await buildInventory(css);
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(path.join(FIXTURE_DIR, 'before.css'), css);
  await writeFile(path.join(FIXTURE_DIR, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
  console.log('Inventory counts:', inventory.counts);
  console.log('Utilities that need the fixed family:');
  for (const row of inventory.utilities.filter((r) => r.needsFixed)) {
    console.log(`  ${row.class} -> ${row.fixed ?? '(no fixed equivalent)'}   [${row.files.join(', ')}]`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
