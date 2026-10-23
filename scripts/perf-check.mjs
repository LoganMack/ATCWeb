// Before-and-after performance measurement of the five model pages (FR11). Read-only: plain GETs with no
// cookies, and Lighthouse in a fresh browser profile. Writes perf-reports/<UTC timestamp>/report.{md,json}.
//
//   node scripts/perf-check.mjs [--base <url>] [--runs 3] [--pages home,driver] [--out perf-reports]
//   node scripts/perf-check.mjs --compare <before dir|report.json> <after dir|report.json>
//
// The browser comes from CHROME_PATH, then Chrome, then Edge.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as chromeLauncher from 'chrome-launcher';
import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import {
  PAGES,
  assertSafeBase,
  cacheStatesFromDevtoolsLog,
  checkFragmentUrl,
  comparisonWarnings,
  fragmentUrlFromHtml,
  judgeTargets,
  renderComparison,
  renderReport,
  runFromLhr,
  summarizePage,
} from './perfCheckLib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE = 'https://alphatouringchallenge.com';
const RUN_TIMEOUT_MS = 120_000;
const GET_TIMEOUT_MS = 30_000;
const USER_AGENT = 'atc-perf-check (read-only measurement)';
const REPEAT_GETS = 3;
const FLOOR_PROBES = 3;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = {
    base: DEFAULT_BASE,
    runs: 3,
    pages: null,
    out: path.join(ROOT, 'perf-reports'),
    compare: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      return v;
    };
    if (arg === '--base') opts.base = next();
    else if (arg === '--runs') {
      opts.runs = Number(next());
      if (!Number.isInteger(opts.runs) || opts.runs < 1 || opts.runs > 10) {
        throw new UsageError('--runs must be a whole number from 1 to 10');
      }
    } else if (arg === '--pages')
      opts.pages = next()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else if (arg === '--out') opts.out = path.resolve(next());
    else if (arg === '--compare') opts.compare = [next(), next()];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new UsageError(`Unknown argument: ${arg}`);
  }
  if (opts.pages) {
    const known = PAGES.map((p) => p.label);
    const unknown = opts.pages.filter((p) => !known.includes(p));
    if (unknown.length)
      throw new UsageError(`Unknown page(s): ${unknown.join(', ')}; known: ${known.join(', ')}`);
  }
  return opts;
}

function findBrowser() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  try {
    const chrome = chromeLauncher.getChromePath();
    if (chrome) candidates.push(chrome);
  } catch {
    // No Chrome installed; Edge below is the fallback.
  }
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)';
  const pf = process.env.ProgramFiles ?? 'C:/Program Files';
  candidates.push(
    path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
    path.join(pf, 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/microsoft-edge',
  );
  return candidates.find((c) => existsSync(c)) ?? null;
}

function localMainCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'main'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (err) {
    console.warn(`Could not read the local main commit: ${err.message}`);
    return 'unknown';
  }
}

function lighthouseVersion() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, 'node_modules/lighthouse/package.json'), 'utf8')).version;
  } catch (err) {
    console.warn(`Could not read the Lighthouse version: ${err.message}`);
    return 'unknown';
  }
}

/** One plain GET: no cookies, no redirects followed, timed to the headers (TTFB) and to the last byte. */
async function timedGet(url, attempt) {
  const result = { url, attempt, status: 0, ttfbMs: null, totalMs: null, bytes: 0, xAtcCache: 'absent' };
  const start = performance.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
      signal: AbortSignal.timeout(GET_TIMEOUT_MS),
    });
    result.ttfbMs = performance.now() - start;
    result.status = res.status;
    result.xAtcCache = res.headers.get('x-atc-cache') ?? 'absent';
    result.cacheControl = res.headers.get('cache-control');
    result.cfCacheStatus = res.headers.get('cf-cache-status');
    const chunks = [];
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (result.firstChunkMs === undefined) result.firstChunkMs = performance.now() - start;
        chunks.push(value);
        result.bytes += value.byteLength;
      }
    }
    result.totalMs = performance.now() - start;
    return { result, body: Buffer.concat(chunks).toString('utf8') };
  } catch (err) {
    result.error = `${err.name}: ${err.message}`;
    console.warn(`GET ${url} failed: ${result.error}`);
    return { result, body: '' };
  }
}

async function timeRepeats(url) {
  const out = [];
  for (let i = 1; i <= REPEAT_GETS; i++) out.push((await timedGet(url, `repeat ${i}`)).result);
  return out;
}

async function timePage(base, page) {
  const url = new URL(page.path, base).toString();
  // The first GET of an unrelated path opens the connection, so TLS setup is not counted and no page
  // cache is touched. The fastest of three more is the client's round trip, the floor under every TTFB.
  const robots = new URL('/robots.txt', base).toString();
  await timedGet(robots, 'warm-up');
  const probes = [];
  for (let i = 0; i < FLOOR_PROBES; i++) probes.push((await timedGet(robots, 'client floor')).result);
  const timed = probes.filter((p) => !p.error && Number.isFinite(p.ttfbMs));
  const floor = timed.length ? timed.reduce((a, b) => (b.ttfbMs < a.ttfbMs ? b : a)) : probes[0];
  floor.samples = probes.map((p) => p.ttfbMs);
  const first = await timedGet(url, 'first');
  const pageTimings = [first.result, ...(await timeRepeats(url))];
  const { url: fragmentUrl, rejected } = checkFragmentUrl(fragmentUrlFromHtml(first.body, base), base);
  const fragment = [];
  if (fragmentUrl) {
    fragment.push((await timedGet(fragmentUrl, 'first')).result, ...(await timeRepeats(fragmentUrl)));
  } else {
    console.warn(`${page.label}: ${rejected ?? 'no data-fragment-url in the shell'}; fragment not timed`);
  }
  console.log(`${page.label}: client latency floor ${Math.round(floor.ttfbMs ?? NaN)} ms`);
  return {
    url,
    fragmentUrl,
    fragmentRejected: rejected,
    timings: { floor, page: pageTimings, fragment },
  };
}

/** GETs of the shell and its fragment so the Lighthouse run that follows meets a cached state. */
async function warm(url, fragmentUrl) {
  const doc = (await timedGet(url, 'warm')).result;
  const frag = fragmentUrl ? (await timedGet(fragmentUrl, 'warm')).result : null;
  return { document: doc.xAtcCache, fragment: frag?.xAtcCache ?? null, source: 'warm-up' };
}

// Edge on Windows never writes its dynamic DevTools port to stderr, so the launcher gets a fixed free port.
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** One Lighthouse run in a fresh, cookie-free profile, killed after RUN_TIMEOUT_MS. */
async function lighthouseRun(url, fragmentUrl, warmed, preset, run, browserPath) {
  let chrome;
  let timer;
  try {
    chrome = await chromeLauncher.launch({
      chromePath: browserPath,
      port: await freePort(),
      chromeFlags: ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions'],
    });
    const flags = { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance'] };
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${RUN_TIMEOUT_MS / 1000} s`)),
        RUN_TIMEOUT_MS,
      );
    });
    const result = await Promise.race([
      lighthouse(url, flags, preset === 'desktop' ? desktopConfig : undefined),
      timeout,
    ]);
    if (!result?.lhr) throw new Error('Lighthouse returned no result');
    const record = runFromLhr(result.lhr, preset, run);
    const seen = cacheStatesFromDevtoolsLog(result.artifacts?.DevtoolsLog, url, fragmentUrl);
    record.cache =
      seen.document && (seen.fragment || !fragmentUrl)
        ? { ...seen, source: 'browser' }
        : {
            document: seen.document ?? warmed.document,
            fragment: seen.fragment ?? warmed.fragment,
            source: 'warm-up',
          };
    return { record, lhr: result.lhr };
  } catch (err) {
    const message = err?.message ?? String(err);
    console.warn(`Lighthouse ${preset} run ${run} of ${url} failed: ${message}`);
    return { record: { preset, run, error: message, cache: warmed }, lhr: null };
  } finally {
    clearTimeout(timer);
    if (chrome) {
      try {
        chrome.kill();
      } catch (err) {
        // Windows can hold the temp profile open briefly; the run's result is unaffected.
        console.warn(`Could not clean up the browser profile: ${err.message}`);
      }
    }
  }
}

function readReport(p) {
  const file = existsSync(p) && statSync(p).isDirectory() ? path.join(p, 'report.json') : p;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new UsageError(`Could not read ${file}: ${err.message}`);
  }
}

function printSummary(report) {
  for (const page of report.pages) {
    const s = summarizePage(page);
    const verdicts = judgeTargets(page)
      .map((v) => `${v.id} ${v.status.toUpperCase()}`)
      .join(', ');
    const fmt = (v) => (v === null || v === undefined ? 'n/a' : Math.round(v));
    console.log(
      `${page.label.padEnd(10)} mobile LCP ${fmt(s.mobile.lcp.value)} ms (${fmt(s.mobile.lcp.min)}–${fmt(s.mobile.lcp.max)}),` +
        ` desktop LCP ${fmt(s.desktop.lcp.value)} ms (${fmt(s.desktop.lcp.min)}–${fmt(s.desktop.lcp.max)},` +
        ` ${s.desktop.lcpRun?.lcpClass ?? 'n/a'}), client floor ${fmt(page.timings?.floor?.ttfbMs)} ms | ${verdicts}`,
    );
  }
}

async function measure(opts) {
  let base;
  try {
    base = assertSafeBase(opts.base);
  } catch (err) {
    throw new UsageError(err.message);
  }
  const browserPath = findBrowser();
  if (!browserPath) {
    throw new UsageError('No Chromium browser found. Set CHROME_PATH to Chrome or Edge.');
  }
  const startedAt = new Date().toISOString();
  const selected = opts.pages ? PAGES.filter((p) => opts.pages.includes(p.label)) : PAGES;
  const report = {
    baseUrl: base,
    startedAt,
    commit: `${localMainCommit()} (local main)`,
    lighthouseVersion: lighthouseVersion(),
    browser: { path: browserPath, version: 'unknown' },
    runs: opts.runs,
    cacheWarming: true,
    partial: selected.length !== PAGES.length,
    pages: [],
  };
  console.log(
    `Measuring ${selected.length} page(s) on ${base} with ${browserPath}, ${opts.runs} run(s) per preset`,
  );
  for (const page of selected) {
    console.log(`${page.label}: timed GETs`);
    const timed = await timePage(base, page);
    const runs = { mobile: [], desktop: [] };
    const batch = await warm(timed.url, timed.fragmentUrl);
    console.log(
      `${page.label}: warmed before Lighthouse (document ${batch.document}, fragment ${batch.fragment ?? '-'})`,
    );
    for (const preset of ['mobile', 'desktop']) {
      for (let run = 1; run <= opts.runs; run++) {
        console.log(`${page.label}: Lighthouse ${preset} ${run}/${opts.runs}`);
        const warmed = await warm(timed.url, timed.fragmentUrl);
        const { record, lhr } = await lighthouseRun(
          timed.url,
          timed.fragmentUrl,
          warmed,
          preset,
          run,
          browserPath,
        );
        runs[preset].push(record);
        if (lhr && report.browser.version === 'unknown') {
          report.browser.version = lhr.environment?.hostUserAgent ?? lhr.userAgent ?? 'unknown';
        }
      }
    }
    report.pages.push({ ...page, ...timed, runs });
  }
  const dir = path.join(opts.out, startedAt.replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(dir, 'report.md'), renderReport(report));
  printSummary(report);
  console.log(`Report written to ${dir}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport')[0]);
    return;
  }
  if (opts.compare) {
    const [before, after] = opts.compare.map(readReport);
    // Repeated on stderr so a reader who pipes the table elsewhere still sees them.
    for (const w of comparisonWarnings(before, after)) console.warn(`WARNING: ${w}`);
    console.log(renderComparison(before, after));
    return;
  }
  await measure(opts);
}

main().catch((err) => {
  console.error(err instanceof UsageError ? err.message : err);
  process.exit(err instanceof UsageError ? 2 : 1);
});
