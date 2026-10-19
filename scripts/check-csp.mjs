#!/usr/bin/env node
// Regression check for the strict script CSP (FR5 / NFR2.5).
//
// Usage: node scripts/check-csp.mjs [baseUrl]        (default http://localhost:8787)
// Needs the built Worker running locally: npm run build && npx wrangler dev
//
// For every page in the FR5.4 list, every fragment those pages load, and (when
// an admin login is available) one admin page per file that used to hold an
// inline handler, it fails when:
//   - the response has no CSP script-src, or script-src allows 'unsafe-inline' / 'unsafe-eval'
//   - an inline <script> (JavaScript) has no matching 'sha256-…' or the response's nonce in script-src
//   - an external <script src> is neither same-origin nor an origin listed in script-src
//   - any element carries an on*= event-handler attribute or a javascript: URL
// It also scans src/ for on*= attributes, define:vars and unhashed is:inline
// scripts, so admin-only templates are covered even without a login.
//
// Admin pages: set ATC_TEST_EMAIL and ATC_TEST_PASSWORD to an admin account
// (never committed). Without them those pages are reported as SKIPPED, not passed.
// Exit code: 0 when nothing failed, 1 otherwise.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.argv[2] || process.env.ATC_BASE_URL || 'http://localhost:8787').replace(/\/$/, '');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
const skipped = [];
let checkedPages = 0;

function fail(where, message) {
  failures.push(`${where}: ${message}`);
}

// --- HTML helpers ----------------------------------------------------------------

const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module', 'text/ecmascript']);

/** Every <script> element: its attributes and raw text. */
function scriptsOf(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  // Comments can mention "<script>" in prose; they are not elements.
  const uncommented = html.replace(/<!--[\s\S]*?-->/g, '');
  while ((m = re.exec(uncommented))) out.push({ attrs: parseAttributes(m[1]), body: m[2] });
  return out;
}

/** Attribute name -> value (lowercased names) for the inside of one tag. */
function parseAttributes(tagInner) {
  const attrs = new Map();
  const re = /([^\s"'>\/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
  let m;
  while ((m = re.exec(tagInner))) {
    let value = m[2] ?? '';
    if (value.startsWith('"') || value.startsWith("'")) value = value.slice(1, -1);
    attrs.set(m[1].toLowerCase(), value);
  }
  return attrs;
}

/** Opening tags outside comments, <script> bodies and <style> bodies. */
function tagsOf(html) {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script\s*>)/gi, '$1$2')
    .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style\s*>)/gi, '$1$2');
  const tags = [];
  const re = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+(?:[^\s"'>\/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
  let m;
  while ((m = re.exec(stripped))) tags.push({ name: m[1].toLowerCase(), attrs: parseAttributes(m[2]) });
  return tags;
}

function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&colon;/gi, ':')
    .replace(/&tab;|&newline;/gi, '')
    .replace(/&amp;/g, '&');
}

function sha256Source(text) {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

function scriptSrcOf(csp) {
  const directive = (csp || '')
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.toLowerCase().startsWith('script-src '));
  return directive ? directive.split(/\s+/).slice(1) : null;
}

// --- Page check ---------------------------------------------------------------------

function checkHtml(where, html, csp) {
  const sources = scriptSrcOf(csp);
  if (!sources) {
    fail(where, 'no script-src in Content-Security-Policy');
    return;
  }
  for (const banned of ["'unsafe-inline'", "'unsafe-eval'"]) {
    if (sources.includes(banned)) fail(where, `script-src contains ${banned}`);
  }

  for (const { attrs, body } of scriptsOf(html)) {
    const type = (attrs.get('type') || '').toLowerCase();
    if (!JS_TYPES.has(type)) continue; // JSON data blocks never execute
    // Only Cloudflare's edge-injected scripts carry the response nonce.
    if (attrs.has('nonce') && sources.includes(`'nonce-${attrs.get('nonce')}'`)) continue;
    if (attrs.has('src')) {
      const src = new URL(decodeEntities(attrs.get('src')), BASE + '/');
      if (src.origin !== new URL(BASE).origin && !sources.includes(src.origin)) {
        fail(where, `external script not allowed by script-src: ${src.href}`);
      }
      continue;
    }
    const hash = sha256Source(body);
    if (!sources.includes(hash)) fail(where, `inline script without a listed hash or nonce (${hash}): ${body.trim().slice(0, 80)}`);
  }

  for (const tag of tagsOf(html)) {
    for (const [name, value] of tag.attrs) {
      if (/^on[a-z]+$/.test(name)) fail(where, `<${tag.name}> has inline handler ${name}="${value.slice(0, 60)}"`);
      if (['href', 'src', 'action', 'formaction'].includes(name) && /^\s*javascript:/i.test(decodeEntities(value))) {
        fail(where, `<${tag.name}> has a javascript: URL in ${name}`);
      }
    }
  }
}

async function fetchPage(urlPath, cookie) {
  const res = await fetch(BASE + urlPath, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
  const html = await res.text();
  return { res, html };
}

/** Checks one page plus the fragment it loads (data-fragment-url), if any. */
async function checkPage(urlPath, { cookie, label } = {}) {
  const where = label || urlPath;
  let page;
  try {
    page = await fetchPage(urlPath, cookie);
  } catch (err) {
    fail(where, `request failed: ${err.message}`);
    return null;
  }
  if (page.res.status >= 300 && page.res.status < 400) {
    return { redirected: page.res.headers.get('location') };
  }
  if (page.res.status !== 200) {
    fail(where, `HTTP ${page.res.status}`);
    return null;
  }
  checkedPages++;
  checkHtml(where, page.html, page.res.headers.get('content-security-policy'));

  for (const tag of tagsOf(page.html)) {
    const fragmentUrl = tag.attrs.get('data-fragment-url');
    if (!fragmentUrl) continue;
    const fragPath = decodeEntities(fragmentUrl);
    const frag = await fetchPage(fragPath, cookie);
    if (frag.res.status !== 200) {
      fail(`${fragPath} (from ${where})`, `HTTP ${frag.res.status}`);
      continue;
    }
    checkedPages++;
    // Every response gets its own nonce, and Cloudflare stamps that response's nonce onto the
    // scripts it injects, so a fragment is checked against its own header. A fragment with no
    // header has no script-src and fails in checkHtml.
    checkHtml(`${fragPath} (from ${where})`, frag.html, frag.res.headers.get('content-security-policy'));
  }
  return { html: page.html };
}

// --- Discovery and login ---------------------------------------------------------------

async function firstMatch(urlPath, pattern) {
  const { html } = await fetchPage(urlPath);
  const m = pattern.exec(html);
  return m ? m[1] : null;
}

async function adminCookie() {
  const email = process.env.ATC_TEST_EMAIL;
  const password = process.env.ATC_TEST_PASSWORD;
  if (!email || !password) return null;
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE },
    body: new URLSearchParams({ email, password }),
  });
  const cookies = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).filter((c) => /^atc_(at|rt)=/.test(c));
  return cookies.length > 0 ? cookies.join('; ') : null;
}

// --- Static source scan ------------------------------------------------------------------

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(astro|ts|tsx|js|mjs|html)$/.test(entry.name)) yield full;
  }
}

async function scanSources() {
  const hashesSource = await readFile(path.join(ROOT, 'src/lib/csp.ts'), 'utf8');
  for await (const file of walk(path.join(ROOT, 'src'))) {
    if (file.includes(`${path.sep}vendor${path.sep}`)) continue;
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const text = await readFile(file, 'utf8');
    if (rel.endsWith('.astro')) {
      // Markup only: drop JSX/HTML comments and script/style bodies.
      const markup = text
        .replace(/^---[\s\S]*?\n---/, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script\s*>)/gi, '$1$2')
        .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style\s*>)/gi, '$1$2');
      for (const m of markup.matchAll(/<[a-zA-Z][^>]*?\son[a-z]+\s*=/g)) fail(rel, `inline handler in template: ${m[0].slice(0, 80)}`);
      if (/<script\b[^>]*define:vars/.test(text)) fail(rel, 'define:vars script (renders a per-request inline script)');
      for (const m of text.matchAll(/<script\b([^>]*)\bis:inline\b([^>]*)>/g)) {
        const attrs = m[1] + m[2];
        if (/type=["']application\/(ld\+)?json["']/.test(attrs)) continue;
        if (!/set:html=\{THEME_INIT_SCRIPT\}/.test(attrs)) fail(rel, 'is:inline script whose hash is not managed in src/lib/csp.ts');
      }
    }
    if (rel.endsWith('.ts') && /innerHTML\s*=.*\son[a-z]+=/.test(text)) fail(rel, 'HTML string with an inline handler');
  }
  if (!/INLINE_SCRIPT_HASHES/.test(hashesSource)) fail('src/lib/csp.ts', 'INLINE_SCRIPT_HASHES missing');
}

// --- Self-test: the detector must catch known-bad markup -------------------------------

function selfTest() {
  const csp = "script-src 'self' " + sha256Source('ok();') + " 'nonce-abc' https://static.cloudflareinsights.com";
  const cases = [
    ['<script>ok();</script><p>fine</p>', 0],
    ['<script>evil();</script>', 1],
    ['<script nonce="abc">edge();</script>', 0],
    ['<script nonce="xyz">edge();</script>', 1],
    ['<script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script>', 0],
    ['<select onchange="go()"></select>', 1],
    ['<a href="javascript:alert(1)">x</a>', 1],
    ['<script type="application/json">{"a":1}</script>', 0],
    ['<script src="https://cdn.example/x.js"></script>', 1],
    ['<!-- <b onclick="x()"> --><p data-note="onclick=1">ok</p>', 0],
  ];
  const before = failures.length;
  for (const [html, expected] of cases) {
    const start = failures.length;
    checkHtml('self-test', html, csp);
    const got = failures.length - start;
    if (got !== expected) {
      console.error(`Self-test failed for ${html}: expected ${expected} finding(s), got ${got}`);
      process.exit(1);
    }
  }
  checkHtml('self-test', '<p>x</p>', "script-src 'self' 'unsafe-inline'");
  if (failures.length - before !== cases.reduce((n, [, e]) => n + e, 0) + 1) {
    console.error("Self-test failed: 'unsafe-inline' was not reported");
    process.exit(1);
  }
  failures.length = before;
}

// --- Run ----------------------------------------------------------------------------

async function main() {
  selfTest();
  console.log(`check-csp against ${BASE}`);
  try {
    await fetch(BASE + '/');
  } catch {
    console.error(`Cannot reach ${BASE}. Start the Worker first: npm run build && npx wrangler dev`);
    process.exit(2);
  }

  await scanSources();

  const subsessionId = await firstMatch('/results/fragment', /href="\/results\/(\d+)[?"]/);
  const driverId = await firstMatch('/roster/fragment', /\/drivers\/([0-9a-f-]{36})\b/);

  const publicPages = ['/', '/login', '/signup', '/standings'];
  if (subsessionId) publicPages.push(`/results/${subsessionId}`, `/results/${subsessionId}/incidents`, `/results/${subsessionId}/kudos`);
  else fail('discovery', 'no round found on /results/fragment, so the results model pages were not checked');
  if (driverId) publicPages.push(`/drivers/${driverId}`);
  else fail('discovery', 'no driver found on /roster/fragment, so the driver model page was not checked');
  // Pages whose own markup held inline handlers.
  publicPages.push('/calendar', '/champions', '/driver-stats', '/team-stats', '/media', '/results', '/teams', '/hall-of-fame');

  for (const p of publicPages) await checkPage(p);

  const cookie = await adminCookie();
  const adminPages = ['/admin/awards', '/admin/interviews', '/admin/rulesets', '/admin/seasons', '/admin/users', '/admin/import'];
  if (cookie) {
    // admin/teams/[id].astro held a handler; take the first team from the admin list.
    const { html } = await fetchPage('/admin/teams', cookie);
    const teamId = /\/admin\/teams\/([0-9a-f-]{36})\b/.exec(html)?.[1];
    if (teamId) adminPages.push(`/admin/teams/${teamId}`);
    else fail('discovery', 'no team found on /admin/teams, so admin/teams/[id] was not checked');
  } else {
    adminPages.push('/admin/teams/[id]');
  }
  for (const p of adminPages) {
    if (!cookie) {
      skipped.push(`${p} (no ATC_TEST_EMAIL/ATC_TEST_PASSWORD admin login)`);
      continue;
    }
    const result = await checkPage(p, { cookie });
    if (result?.redirected) skipped.push(`${p} (redirected to ${result.redirected}: the test account is not an admin)`);
  }

  console.log(`Checked ${checkedPages} page(s) and fragment(s), plus a scan of src/.`);
  for (const s of skipped) console.log(`SKIPPED ${s}`);
  if (failures.length) {
    for (const f of failures) console.log(`FAIL ${f}`);
    console.log(`${failures.length} failure(s).`);
    process.exit(1);
  }
  console.log(`PASS (${skipped.length} skipped)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
