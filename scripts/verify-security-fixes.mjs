#!/usr/bin/env node
// Regression checks for the security fixes FR2, FR3, FR6, FR8 and FR12
// (NFR2.2, 2.3, 2.6, 2.8, 2.14, 2.15).
//
// Usage: node scripts/verify-security-fixes.mjs [baseUrl]   (default http://localhost:8787)
// Needs Node 22.6+ (imports src/lib/*.ts with type stripping; on Node 22 add
// --experimental-strip-types) and the built Worker running locally:
//   npm run build && npx wrangler dev
//
// The local Worker reads the production Supabase project with the public anon
// key. Checks that would call Supabase Auth are opt-in:
//   ATC_ALLOW_AUTH_CHECKS=1   sign-in attempts (unknown email, and ATC_TEST_EMAIL with a wrong password)
//   ATC_ALLOW_SIGNUP_WRITE=1  sign-up with a brand-new example.test address (creates an auth user)
//   ATC_TEST_EMAIL / ATC_TEST_PASSWORD  an existing (admin) test account, never committed
// Anything not run is printed as SKIPPED, never as a pass. Exit 0 only when nothing failed.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.argv[2] || process.env.ATC_BASE_URL || 'http://localhost:8787').replace(/\/$/, '');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GENERIC_LOAD_ERROR = "We couldn't load this right now. Please try again shortly.";
const LOGIN_FAILED = "Email or password is incorrect, or the account isn't confirmed yet.";
const SIGNUP_DONE = 'Check your email to confirm your account.';
const LEAK_MARKERS = [
  'Supabase REST error',
  'invalid input syntax',
  'PGRST',
  '0004_champions.sql',
  'PUBLIC_SUPABASE_URL',
];

const results = [];
function record(id, name, outcome, detail = '') {
  results.push({ id, name, outcome, detail });
  console.log(`${outcome.padEnd(7)} ${id} ${name}${detail ? ` — ${detail}` : ''}`);
}
function check(id, name, ok, detail) {
  record(id, name, ok ? 'PASS' : 'FAIL', ok ? '' : detail);
}

function decodeHtml(text) {
  return text
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function get(urlPath, cookie) {
  const res = await fetch(BASE + urlPath, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
  return { res, body: decodeHtml(await res.text()) };
}

async function postForm(urlPath, fields, cookie) {
  const res = await fetch(BASE + urlPath, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: BASE,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams(fields),
  });
  return { res, body: decodeHtml(await res.text()) };
}

const cacheHeader = (res) => res.headers.get('x-atc-cache');

// --- Unit-level checks (no server) -------------------------------------------------

async function unitChecks() {
  let password, security, edgeCache;
  try {
    password = await import('../src/lib/password.ts');
    security = await import('../src/lib/security.ts');
    edgeCache = await import('../src/lib/edgeCache.ts');
  } catch (err) {
    record(
      'UNIT',
      'import src/lib modules',
      'SKIPPED',
      `needs Node type stripping (${err.message.split('\n')[0]})`,
    );
    return;
  }
  const { validatePassword, PASSWORD_RULE_MESSAGE } = password;
  check(
    'FR8',
    'validatePassword refuses 9 characters',
    validatePassword('a'.repeat(9)) === PASSWORD_RULE_MESSAGE,
  );
  check('FR8', 'validatePassword accepts 10 characters', validatePassword('a'.repeat(10)) === null);
  check('FR8', 'validatePassword accepts 72 ASCII bytes', validatePassword('a'.repeat(72)) === null);
  check(
    'FR8',
    'validatePassword refuses 73 ASCII bytes',
    validatePassword('a'.repeat(73)) === PASSWORD_RULE_MESSAGE,
  );
  check(
    'FR8',
    'validatePassword refuses 37 two-byte characters (74 bytes)',
    validatePassword('é'.repeat(37)) === PASSWORD_RULE_MESSAGE,
  );

  const { isHttpUrl, publicLoadErrorMessage } = security;
  check('FR6', 'isHttpUrl refuses javascript:', isHttpUrl('javascript:alert(1)') === false);
  check('FR6', 'isHttpUrl refuses data:', isHttpUrl('data:text/html,<b>x</b>') === false);
  check('FR6', 'isHttpUrl accepts https', isHttpUrl('https://www.youtube.com/watch?v=abc') === true);
  check('FR2', 'publicLoadErrorMessage is the generic text', publicLoadErrorMessage() === GENERIC_LOAD_ERROR);

  const { cacheKeyUrl, isCacheAnonymous } = edgeCache;
  const key = (u, v) => cacheKeyUrl(new URL(u), v);
  check(
    'FR12',
    'cache key drops unknown query parameters',
    key('https://a.test/standings?x=1&season=3') === 'https://a.test/standings?season=3',
  );
  check(
    'FR12',
    'cache key ignores parameter order',
    key('https://a.test/standings?view=b&class=a') === key('https://a.test/standings?class=a&view=b'),
  );
  check(
    'FR12',
    'broadcaster variant gets its own key',
    key('https://a.test/', 'broadcaster') !== key('https://a.test/'),
  );
  check(
    'FR12',
    'garbage atc_at without atc_rt is anonymous',
    isCacheAnonymous('garbage', undefined) === true,
  );
  check('FR12', 'JWT-shaped atc_at is not anonymous', isCacheAnonymous('aaa.bbb.ccc', undefined) === false);
  check('FR12', 'any atc_rt is not anonymous', isCacheAnonymous(undefined, 'r') === false);
}

// --- Source checks -------------------------------------------------------------------

async function sourceChecks() {
  const login = await readFile(path.join(ROOT, 'src/pages/login.astro'), 'utf8');
  check(
    'FR11.3',
    'login page has no promotion SQL',
    !/update profiles set role|insert into profiles/i.test(login),
  );
  const linksBlock = await readFile(path.join(ROOT, 'src/components/RaceLinksBlock.astro'), 'utf8');
  check('FR6', 'RaceLinksBlock renders links only through isHttpUrl', /isHttpUrl/.test(linksBlock));
}

// --- HTTP checks ---------------------------------------------------------------------

async function loadErrorChecks() {
  // An invalid driver id makes PostgREST error (uuid syntax), so the fragment hits its load-error path.
  const url = '/drivers/not-a-uuid/fragment';
  const first = await get(url);
  const cc = first.res.headers.get('cache-control') ?? '';
  check(
    'FR2',
    'forced failure shows the generic message',
    first.body.includes(GENERIC_LOAD_ERROR),
    'generic text missing',
  );
  const leaked = LEAK_MARKERS.filter((m) => first.body.includes(m));
  check('FR2', 'forced failure leaks no backend detail', leaked.length === 0, `found ${leaked.join(', ')}`);
  check('FR2', 'forced failure is Cache-Control: no-store', /no-store/.test(cc), `Cache-Control: ${cc}`);
  const second = await get(url);
  check(
    'FR2',
    'repeat of a forced failure is not a cache hit',
    cacheHeader(second.res) !== 'HIT',
    `X-ATC-Cache: ${cacheHeader(second.res)}`,
  );
}

function extractMessage(body, marker) {
  return body.includes(marker);
}

async function passwordChecks() {
  const signup = (pw, confirm) =>
    postForm('/signup', {
      email: `pw-check-${Date.now()}@example.test`,
      password: pw,
      confirm_password: confirm,
      display_name: '',
      website: '',
    });
  const resetPw = (pw, confirm) =>
    postForm('/reset-password', {
      password: pw,
      confirm_password: confirm,
      recovery_access_token: '',
      recovery_refresh_token: '',
    });
  const { PASSWORD_RULE_MESSAGE } = await import('../src/lib/password.ts').catch(() => ({
    PASSWORD_RULE_MESSAGE: 'Password must be at least 10 characters',
  }));

  // "Accepted" is proven without calling Supabase: the password passes the rule
  // and the request stops at the next check (mismatched confirmation / no reset token).
  const nine = 'a'.repeat(9);
  const ascii72 = 'a'.repeat(72);
  const twoByte37 = 'é'.repeat(37);
  for (const [page, send, acceptedMarker] of [
    ['sign-up', signup, "Passwords don't match."],
    ['reset', resetPw, 'This reset link is invalid or has expired'],
  ]) {
    const r9 = await send(nine, nine);
    check(
      'FR8',
      `${page}: 9 characters refused with the shared message`,
      extractMessage(r9.body, PASSWORD_RULE_MESSAGE),
      'shared message missing',
    );
    const r72 = await send(ascii72, ascii72 + 'x');
    check(
      'FR8',
      `${page}: 72 ASCII characters accepted by the rule`,
      !r72.body.includes(PASSWORD_RULE_MESSAGE) && r72.body.includes(acceptedMarker),
      'rule refused it',
    );
    const r37 = await send(twoByte37, twoByte37);
    check(
      'FR8',
      `${page}: 37 two-byte characters (74 bytes) refused`,
      extractMessage(r37.body, PASSWORD_RULE_MESSAGE),
      'shared message missing',
    );
  }
}

async function authMessageChecks() {
  if (process.env.ATC_ALLOW_AUTH_CHECKS !== '1') {
    record(
      'FR3',
      'sign-in messages identical across account states',
      'SKIPPED',
      'set ATC_ALLOW_AUTH_CHECKS=1 (calls Supabase Auth)',
    );
  } else {
    const unknown = await postForm('/login', {
      email: `nobody-${Date.now()}@example.test`,
      password: 'wrong-password-123',
    });
    check(
      'FR3',
      'sign-in: unknown email gets the generic message',
      unknown.body.includes(LOGIN_FAILED),
      'generic message missing',
    );
    if (process.env.ATC_TEST_EMAIL) {
      const wrong = await postForm('/login', {
        email: process.env.ATC_TEST_EMAIL,
        password: 'definitely-wrong-password-123',
      });
      check(
        'FR3',
        'sign-in: existing email with a wrong password gets the same message',
        wrong.body.includes(LOGIN_FAILED),
        'generic message missing',
      );
    } else {
      record('FR3', 'sign-in: existing email with a wrong password', 'SKIPPED', 'set ATC_TEST_EMAIL');
    }
    record('FR3', 'sign-in: unconfirmed email', 'SKIPPED', 'manual check (needs an unconfirmed account)');
  }

  if (process.env.ATC_ALLOW_AUTH_CHECKS === '1' && process.env.ATC_TEST_EMAIL) {
    const pw = 'Valid-pass-1234';
    const existing = await postForm('/signup', {
      email: process.env.ATC_TEST_EMAIL,
      password: pw,
      confirm_password: pw,
      display_name: '',
      website: '',
    });
    check(
      'FR3',
      'sign-up: existing email shows the standard success text',
      existing.body.includes(SIGNUP_DONE),
      'success text missing',
    );
  } else {
    record('FR3', 'sign-up: existing email', 'SKIPPED', 'set ATC_ALLOW_AUTH_CHECKS=1 and ATC_TEST_EMAIL');
  }
  if (process.env.ATC_ALLOW_SIGNUP_WRITE === '1') {
    const pw = 'Valid-pass-1234';
    const fresh = await postForm('/signup', {
      email: `new-${Date.now()}@example.test`,
      password: pw,
      confirm_password: pw,
      display_name: '',
      website: '',
    });
    check(
      'FR3',
      'sign-up: new email shows the same success text',
      fresh.body.includes(SIGNUP_DONE),
      'success text missing',
    );
  } else {
    record('FR3', 'sign-up: new email', 'SKIPPED', 'set ATC_ALLOW_SIGNUP_WRITE=1 (creates an auth user)');
  }
}

async function adminCookie() {
  if (
    !process.env.ATC_TEST_EMAIL ||
    !process.env.ATC_TEST_PASSWORD ||
    process.env.ATC_ALLOW_AUTH_CHECKS !== '1'
  )
    return null;
  const { res } = await postForm('/login', {
    email: process.env.ATC_TEST_EMAIL,
    password: process.env.ATC_TEST_PASSWORD,
  });
  const cookies = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .filter((c) => /^atc_(at|rt)=/.test(c));
  return cookies.length ? cookies.join('; ') : null;
}

async function raceLinkChecks() {
  const cookie = await adminCookie();
  if (!cookie) {
    record(
      'FR6',
      'admin save refuses a javascript: link',
      'SKIPPED',
      'needs an admin login (ATC_ALLOW_AUTH_CHECKS=1, ATC_TEST_EMAIL, ATC_TEST_PASSWORD)',
    );
    return;
  }
  const { body } = await get('/results/fragment');
  const subsessionId = /\/results\/(\d+)\b/.exec(body)?.[1];
  if (!subsessionId) {
    record('FR6', 'admin save refuses a javascript: link', 'FAIL', 'no round found on /results/fragment');
    return;
  }
  // Refused before any write, so nothing reaches race_links.
  const { res } = await postForm(
    `/results/${subsessionId}/fragment`,
    {
      intent: 'save-race-links',
      subsession_id: subsessionId,
      race_number: '1',
      replay_url: 'javascript:alert(1)',
      broadcast_url: '',
      photo_album_url: '',
    },
    cookie,
  );
  const location = res.headers.get('location') ?? '';
  check(
    'FR6',
    'admin save refuses a javascript: link with a field error',
    res.status === 302 && location.includes('links_error=replay_url'),
    `status ${res.status}, location ${location}`,
  );
}

async function cacheChecks() {
  const page = '/standings';
  const rand = () => Math.random().toString(36).slice(2);
  // Warm the plain key, then a different junk parameter must hit it.
  await get(`${page}?x=${rand()}`);
  const junk = await get(`${page}?x=${rand()}`);
  if (junk.res.headers.get('x-atc-cache') === null) {
    record(
      'FR12',
      'edge cache present',
      'SKIPPED',
      'no X-ATC-Cache header (cache API unavailable on this server?)',
    );
    return;
  }
  check(
    'FR12',
    'unknown query parameter is served from cache',
    cacheHeader(junk.res) === 'HIT',
    `X-ATC-Cache: ${cacheHeader(junk.res)}`,
  );

  const garbage = await get(page, 'atc_at=garbage');
  check(
    'FR12',
    'garbage atc_at is served from cache',
    cacheHeader(garbage.res) === 'HIT',
    `X-ATC-Cache: ${cacheHeader(garbage.res)}`,
  );
  const cleared = (garbage.res.headers.getSetCookie?.() ?? []).some(
    (c) => /^atc_at=/.test(c) && /(Max-Age=0|Expires=Thu, 01 Jan 1970)/i.test(c),
  );
  check('FR12', 'garbage atc_at is cleared', cleared, 'no clearing Set-Cookie for atc_at');

  const b1 = await get(page, 'atc_broadcaster=1');
  const b2 = await get(page, 'atc_broadcaster=1');
  check(
    'FR12',
    'broadcaster repeat is served from cache',
    cacheHeader(b2.res) === 'HIT',
    `X-ATC-Cache: ${cacheHeader(b2.res)}`,
  );
  const bcc = b2.res.headers.get('cache-control') ?? '';
  check(
    'FR12',
    'broadcaster response is private, no-store for the browser',
    /private/.test(bcc) && /no-store/.test(bcc),
    `Cache-Control: ${bcc}`,
  );
  const isBroadcasterMarkup = (body) => /name="mode" value="off"/.test(body);
  check(
    'FR12',
    'broadcaster render carries broadcaster markup',
    isBroadcasterMarkup(b1.body) && isBroadcasterMarkup(b2.body),
    'footer toggle not in broadcaster state',
  );
  const normal = await get(page);
  check(
    'FR12',
    'normal request right after broadcaster has no broadcaster markup',
    !isBroadcasterMarkup(normal.body),
    'broadcaster markup leaked',
  );
  const b3 = await get(page, 'atc_broadcaster=1');
  check(
    'FR12',
    'broadcaster request right after normal keeps broadcaster markup',
    isBroadcasterMarkup(b3.body),
    'normal markup served to broadcaster',
  );
}

// --- Run ---------------------------------------------------------------------------------

async function main() {
  console.log(`verify-security-fixes against ${BASE}`);
  await unitChecks();
  await sourceChecks();
  try {
    await fetch(BASE + '/');
  } catch {
    record(
      'HTTP',
      'local Worker reachable',
      'FAIL',
      `cannot reach ${BASE}; run npm run build && npx wrangler dev`,
    );
    return finish();
  }
  await loadErrorChecks();
  await passwordChecks();
  await authMessageChecks();
  await raceLinkChecks();
  await cacheChecks();
  finish();
}

function finish() {
  const count = (o) => results.filter((r) => r.outcome === o).length;
  console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIPPED')} skipped.`);
  process.exit(count('FAIL') > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
