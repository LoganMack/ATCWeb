#!/usr/bin/env node
// Page snapshots for proving a change leaves rendered HTML untouched (NFR1),
// such as the one-time Prettier pass or a refactor.
//
// Usage:
//   node scripts/snapshot-pages.mjs <baseUrl> <outDir> --fresh-cache [--subsession <id>] [--driver <uuid>] [--extra <path>]...
//       Fetches the public pages below, plus every fragment they load
//       (data-fragment-url), from a running Worker and saves normalised HTML,
//       one file per page. Needs: npm run build && npx wrangler dev --persist-to <new empty dir>.
//       --fresh-cache confirms the Worker was started on an empty cache; capture refuses without it.
//       --extra <path> (repeatable, e.g. --extra /login --extra /news/<slug>) captures that
//       page, and its fragments, alongside the default list. The path must start with a single /.
//   node scripts/snapshot-pages.mjs --base <baseUrl> --out <outDir> --paths-file <file> --fresh-cache
//       Captures exactly the paths listed in <file> (one per line; blank lines and # comments skipped),
//       instead of the default list, plus every fragment they load, fragments inside fragments included.
//       scripts/snapshot-paths.mjs writes the page-loading list. --base and --out may replace the two
//       positional arguments in any capture.
//   node scripts/snapshot-pages.mjs --compare <dirA> <dirB>
//       Prints a per-page summary and exits 1 on any difference.
//   node scripts/snapshot-pages.mjs --self-test
//       Runs only the built-in self-test (it also runs before every other mode).
//
// The round and driver pages need real ids. By default the first round on
// /results/fragment and the first driver on /roster/fragment are used (the same
// discovery as check-csp.mjs); --subsession and --driver pin them instead, so a
// "before" and "after" pair can be taken against the same records.
//
// Normalised away, because they change per request or per build rather than
// with the markup: CSP nonces, /_astro/ hashed asset names, Astro scope ids (data-astro-cid-*),
// calendar-invite DTSTAMP lines, Cloudflare-injected scripts, the order of class tokens (the Tailwind Prettier
// plugin re-sorts them) and whitespace that cannot render (runs collapse to one
// space; space next to block-level tags is dropped). Whitespace inside <pre> and
// <textarea> is kept as is.
// Exit codes: 0 success, 1 differences or failed requests, 2 usage or Worker unreachable.
// Dependency-free: Node 22 built-ins only.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PAGES = [
  '/',
  '/standings',
  '/results',
  '/teams',
  '/roster',
  '/calendar',
  '/champions',
  '/hall-of-fame',
  '/news',
  '/media',
  '/driver-stats',
  '/team-stats',
];

// Tags where neighbouring whitespace never renders. Inline tags (span, a, svg,
// select, script…) are left out on purpose: space next to them can be visible.
const BLOCK_TAGS = (
  'address article aside blockquote body br dd details dialog div dl dt fieldset figcaption figure ' +
  'footer form h1 h2 h3 h4 h5 h6 head header hr html li link main meta nav ol option p section ' +
  'summary table tbody td tfoot th thead title tr ul path g defs use symbol base !doctype'
).split(' ');
const BLOCK_TAG_RE = new RegExp(`\\s*(<\\/?(?:${BLOCK_TAGS.join('|')})(?=[\\s/>])[^>]*>)\\s*`, 'gi');

// --- Normalisation -------------------------------------------------------------------

function normalise(html) {
  // Keep whitespace-significant bodies out of the collapse, then put them back.
  const kept = [];
  let out = html.replace(/<(pre|textarea)\b[\s\S]*?<\/\1\s*>/gi, (m) => {
    kept.push(m);
    return `${kept.length - 1}`;
  });

  out = out
    // A calendar invite's DTSTAMP is the time it was generated, so it differs on every request.
    .replace(/^DTSTAMP:[^\r\n]*/gm, 'DTSTAMP:MASKED')
    // Scripts Cloudflare adds at the edge (analytics beacon, /cdn-cgi/ helpers).
    .replace(/<script\b[^>]*(?:cloudflareinsights\.com|\/cdn-cgi\/)[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>(?:(?!<\/script)[\s\S])*?\/cdn-cgi\/[\s\S]*?<\/script\s*>/gi, '')
    .replace(/\bnonce="[^"]*"/gi, 'nonce="NONCE"')
    .replace(/'nonce-[^']*'/g, "'nonce-NONCE'")
    .replace(/(\/_astro\/[^"'\s()?#]*?)\.[A-Za-z0-9_-]{8}\.([a-z0-9]+)\b/g, '$1.HASH.$2')
    .replace(/\bdata-astro-cid-[a-z0-9]+/g, 'data-astro-cid-X')
    .replace(/(\sclass=")([^"]*)"/gi, (_, lead, value) => `${lead}${sortClasses(value)}"`)
    .replace(/(\sclass=')([^']*)'/gi, (_, lead, value) => `${lead}${sortClasses(value)}'`)
    .replace(/\s+/g, ' ')
    .replace(BLOCK_TAG_RE, '$1')
    .trim();

  return out.replace(/(\d+)/g, (_, i) => kept[Number(i)]);
}

function sortClasses(value) {
  return value.split(/\s+/).filter(Boolean).sort().join(' ');
}

/** First point where two normalised pages differ, with a little context, or null. */
function firstDifference(a, b) {
  if (a === b) return null;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 60);
  return { offset: i, a: a.slice(from, i + 80), b: b.slice(from, i + 80) };
}

// --- Self-test -----------------------------------------------------------------------

function selfTest() {
  const same = (x, y) => normalise(x) === normalise(y);
  const cases = [
    ['nonce masking', same('<script nonce="abc123">x()</script>', '<script nonce="zz9">x()</script>'), true],
    [
      'asset-hash masking',
      same(
        '<script src="/_astro/hoisted.B8mtkial.js"></script>',
        '<script src="/_astro/hoisted.9d2kOBdS.js"></script>',
      ),
      true,
    ],
    [
      'whitespace collapse',
      same('<div>\n  <p>a  b</p>\n</div> <span>c</span>', '<div><p>a b</p></div> <span>c</span>'),
      true,
    ],
    [
      'class-order normalisation',
      same('<p class="mt-2 text-sm  font-bold">x</p>', '<p class="font-bold mt-2 text-sm">x</p>'),
      true,
    ],
    ['text change detected', same('<p>Round 4</p>', '<p>Round 5</p>'), false],
    ['removed element detected', same('<ul><li>a</li><li>b</li></ul>', '<ul><li>a</li></ul>'), false],
    [
      'DTSTAMP masking',
      same(
        'BEGIN:VEVENT\r\nDTSTAMP:20261020T181952Z\r\nSUMMARY:Round 1\r\nEND:VEVENT\r\n',
        'BEGIN:VEVENT\r\nDTSTAMP:20261021T090000Z\r\nSUMMARY:Round 1\r\nEND:VEVENT\r\n',
      ),
      true,
    ],
    ['capture refused without --fresh-cache', checkCaptureArgs(['--base', 'x']) !== null, true],
    ['capture allowed with --fresh-cache', checkCaptureArgs(['--base', 'x', '--fresh-cache']), null],
    [
      'paths file: one path per line, comments and blanks skipped',
      JSON.stringify(parsePathsList('# pages\n/\n\n/standings?season=17  \r\n/drivers/abc\n')),
      JSON.stringify(['/', '/standings?season=17', '/drivers/abc']),
    ],
    [
      'paths file: a path not starting with one / is refused',
      pathsListProblem(['/', '//evil', 'x']),
      '//evil',
    ],
    [
      'fragment urls found and decoded',
      JSON.stringify(
        fragmentUrls('<div data-fragment-url="/a/fragment?x=1&amp;y=2"></div><div data-fragment-url="/b">'),
      ),
      JSON.stringify(['/a/fragment?x=1&y=2', '/b']),
    ],
    [
      'repeated --extra parsed and removed',
      (() => {
        const args = ['http://x', 'out', '--extra', '/login', '--fresh-cache', '--extra', '/news/a-b'];
        const extras = flagValues(args, '--extra');
        return JSON.stringify({ extras, args });
      })(),
      JSON.stringify({ extras: ['/login', '/news/a-b'], args: ['http://x', 'out', '--fresh-cache'] }),
    ],
  ];
  const failed = cases.filter(([, got, want]) => got !== want);
  for (const [name] of failed) console.error(`self-test FAILED: ${name}`);
  if (failed.length) process.exit(1);
  console.log(`self-test: ${cases.length} passed`);
}

// --- Capture -------------------------------------------------------------------------

function fileNameFor(urlPath) {
  const name = urlPath
    .replace(/^\//, '')
    .replace(/[^A-Za-z0-9-]+/g, '_')
    .replace(/_+$/, '');
  return `${name || 'home'}.html`;
}

function decodeAttr(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

/** The fragment URLs a page loads (data-fragment-url), decoded, in order. */
function fragmentUrls(html) {
  return [...html.matchAll(/\sdata-fragment-url="([^"]+)"/g)].map((m) => decodeAttr(m[1]));
}

/** The paths in a --paths-file: one per line, trimmed; blank lines and # comments are skipped. */
function parsePathsList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** The first listed path that would leave the Worker being captured (not one leading /), or null. */
function pathsListProblem(paths) {
  return paths.find((p) => !/^\/(?!\/)/.test(p)) ?? null;
}

async function fetchText(base, urlPath) {
  const res = await fetch(base + urlPath, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  return { status: res.status, html: await res.text() };
}

async function discover(base, urlPath, pattern, label) {
  const { status, html } = await fetchText(base, urlPath);
  const id = status === 200 ? pattern.exec(html)?.[1] : null;
  if (!id) throw new Error(`no ${label} found on ${urlPath} (HTTP ${status}); pass it with --${label}`);
  return id;
}

function flagValue(args, flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) usage(`${flag} needs a value`);
  args.splice(i, 2);
  return value;
}

/** Every value of a repeatable flag, in order, removed from args. */
function flagValues(args, flag) {
  const values = [];
  let value;
  while ((value = flagValue(args, flag)) !== null) values.push(value);
  return values;
}

/**
 * Null when a capture may run, otherwise why not. A Worker started on an old cache can serve pages
 * from an earlier build and hide a change, so the caller must confirm a fresh cache.
 */
function checkCaptureArgs(args) {
  if (args.includes('--fresh-cache')) return null;
  return (
    'refusing to capture without --fresh-cache: start the Worker on an empty cache ' +
    '(npx wrangler dev --persist-to <new empty dir>), then pass --fresh-cache'
  );
}

async function capture(rawArgs) {
  const refusal = checkCaptureArgs(rawArgs);
  if (refusal) usage(refusal);
  // The flag is recorded above, so it never counts as one of the two positional arguments.
  const args = rawArgs.filter((a) => a !== '--fresh-cache');
  const subsessionFlag = flagValue(args, '--subsession');
  const driverFlag = flagValue(args, '--driver');
  const extraPaths = flagValues(args, '--extra');
  const pathsFile = flagValue(args, '--paths-file');
  const baseFlag = flagValue(args, '--base');
  const outFlag = flagValue(args, '--out');
  if (baseFlag) args.unshift(baseFlag);
  if (outFlag) args.push(outFlag);
  if (args.length !== 2) usage('capture needs <baseUrl> <outDir> (or --base and --out)');
  const base = args[0].replace(/\/$/, '');
  const outDir = path.resolve(args[1]);

  let listedPaths = null;
  if (pathsFile) {
    try {
      listedPaths = parsePathsList(await readFile(pathsFile, 'utf8'));
    } catch (err) {
      usage(`cannot read --paths-file ${pathsFile}: ${err.message}`);
    }
    const bad = pathsListProblem(listedPaths);
    if (bad !== null) usage(`--paths-file paths must start with one /: ${bad}`);
    if (listedPaths.length === 0) usage(`--paths-file ${pathsFile} lists no paths`);
  }

  if (subsessionFlag && !/^\d+$/.test(subsessionFlag)) usage('--subsession must be a number');
  if (driverFlag && !/^[0-9a-f-]{36}$/i.test(driverFlag)) usage('--driver must be a UUID');
  // A single leading slash keeps every extra page on the Worker being captured.
  for (const p of extraPaths)
    if (!/^\/(?!\/)/.test(p)) usage(`--extra must be a path starting with one /: ${p}`);

  try {
    await fetchText(base, '/');
  } catch {
    console.error(`Cannot reach ${base}. Start the Worker first: npm run build && npx wrangler dev`);
    process.exit(2);
  }

  let pages;
  if (listedPaths) {
    pages = [...listedPaths, ...extraPaths];
    console.log(`snapshot ${base} -> ${outDir} (${listedPaths.length} path(s) from ${pathsFile})`);
  } else {
    const subsessionId =
      subsessionFlag ??
      (await discover(base, '/results/fragment', /href="\/results\/(\d+)[?"]/, 'subsession'));
    const driverId =
      driverFlag ?? (await discover(base, '/roster/fragment', /\/drivers\/([0-9a-f-]{36})\b/, 'driver'));
    console.log(`snapshot ${base} -> ${outDir} (round ${subsessionId}, driver ${driverId})`);
    pages = [
      ...PAGES,
      `/results/${subsessionId}`,
      `/results/${subsessionId}/incidents`,
      `/drivers/${driverId}`,
      ...extraPaths,
    ];
  }
  await mkdir(outDir, { recursive: true });
  const failures = [];
  const seen = new Set();
  let saved = 0;

  const save = async (urlPath) => {
    if (seen.has(urlPath)) return null;
    seen.add(urlPath);
    let page;
    try {
      page = await fetchText(base, urlPath);
    } catch (err) {
      failures.push(`${urlPath}: request failed: ${err.message}`);
      return null;
    }
    if (page.status !== 200) {
      failures.push(`${urlPath}: HTTP ${page.status}`);
      return null;
    }
    await writeFile(path.join(outDir, fileNameFor(urlPath)), normalise(page.html) + '\n', 'utf8');
    saved++;
    return page.html;
  };

  // A fragment can carry its own fragment (the driver profile's Awards card), so follow them all.
  const saveWithFragments = async (urlPath) => {
    const html = await save(urlPath);
    if (!html) return;
    for (const url of fragmentUrls(html)) await saveWithFragments(url);
  };
  for (const urlPath of pages) await saveWithFragments(urlPath);

  console.log(`Saved ${saved} page(s) and fragment(s).`);
  if (failures.length) {
    for (const f of failures) console.log(`FAIL ${f}`);
    process.exit(1);
  }
}

// --- Compare -------------------------------------------------------------------------

async function htmlFiles(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.html')).sort();
  } catch (err) {
    usage(`cannot read ${dir}: ${err.message}`);
  }
}

async function compare(args) {
  if (args.length !== 2) usage('--compare needs <dirA> <dirB>');
  const [dirA, dirB] = args.map((d) => path.resolve(d));
  const [filesA, filesB] = await Promise.all([htmlFiles(dirA), htmlFiles(dirB)]);
  const names = [...new Set([...filesA, ...filesB])].sort();
  let differences = 0;

  for (const name of names) {
    if (!filesA.includes(name) || !filesB.includes(name)) {
      differences++;
      console.log(`DIFF ${name}: only in ${filesA.includes(name) ? dirA : dirB}`);
      continue;
    }
    // Normalise again so snapshots from an older version of this script still compare fairly.
    const a = normalise(await readFile(path.join(dirA, name), 'utf8'));
    const b = normalise(await readFile(path.join(dirB, name), 'utf8'));
    const diff = firstDifference(a, b);
    if (!diff) {
      console.log(`SAME ${name}`);
      continue;
    }
    differences++;
    console.log(`DIFF ${name} at character ${diff.offset}`);
    console.log(`  A: …${diff.a}…`);
    console.log(`  B: …${diff.b}…`);
  }

  console.log(`${names.length} page(s) compared, ${differences} difference(s).`);
  process.exit(differences ? 1 : 0);
}

// --- Run -----------------------------------------------------------------------------

function usage(message) {
  console.error(`snapshot-pages: ${message}`);
  console.error(
    'Usage: node scripts/snapshot-pages.mjs <baseUrl> <outDir> --fresh-cache [--subsession <id>] [--driver <uuid>] [--extra <path>]...',
  );
  console.error(
    '       node scripts/snapshot-pages.mjs --base <baseUrl> --out <outDir> --paths-file <file> --fresh-cache',
  );
  console.error('       node scripts/snapshot-pages.mjs --compare <dirA> <dirB>');
  console.error('       node scripts/snapshot-pages.mjs --self-test');
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  selfTest();
  if (args[0] === '--self-test') return;
  if (args[0] === '--compare') return compare(args.slice(1));
  return capture(args);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
