/**
 * Repository rules for the email notifications (U7: BR10.15-BR10.18, NFR5.1, NFR8.3, NFR9.3): the service
 * key and the Resend key stay in their modules, nothing imports the Worker entry or the build output, the
 * Worker configuration (entry, cron, vars), the post-build type check in CI and Deploy, and the admin home's
 * email counts.
 */
import { describe, expect, it } from 'vitest';
// Direct imports, because import.meta.glob skips dot-folders such as .github.
import CI from '../../.github/workflows/ci.yml?raw';
import DEPLOY from '../../.github/workflows/deploy.yml?raw';

const raw = (files: Record<string, unknown>) => files as Record<string, string>;
const SRC = raw(
  import.meta.glob('/src/**/*.{astro,ts,js,mjs}', { query: '?raw', import: 'default', eager: true }),
);
const TESTS = raw(import.meta.glob('/tests/**/*.ts', { query: '?raw', import: 'default', eager: true }));
const SCRIPTS = raw(
  import.meta.glob('/scripts/**/*.{mjs,ts}', { query: '?raw', import: 'default', eager: true }),
);
const CONFIG = raw(
  import.meta.glob(['/wrangler.jsonc', '/tsconfig.json', '/tsconfig.worker.json'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
);

const THIS_FILE = '/tests/structure/notifications.test.ts';

/** Every module specifier a file imports, re-exports or loads dynamically. */
function specifiers(text: string): string[] {
  return [...text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

function filesImporting(files: Record<string, string>, pattern: RegExp): string[] {
  return Object.entries(files)
    .filter(([path]) => path !== THIS_FILE)
    .filter(([, text]) => specifiers(text).some((s) => pattern.test(s)))
    .map(([path]) => path);
}

/** JSON with comments and trailing commas, as wrangler.jsonc and tsconfig.worker.json are written. */
function parseJsonc(text: string): Record<string, unknown> {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
}

const WRANGLER = parseJsonc(CONFIG['/wrangler.jsonc']) as {
  main: string;
  triggers?: { crons?: string[] };
  vars: Record<string, string>;
};

describe('email notifications: secrets stay confined (NFR5.1)', () => {
  it('references SUPABASE_SERVICE_ROLE_KEY only in signups.ts, src/lib/notifications and the env types', () => {
    const users = Object.entries(SRC)
      .filter(([, text]) => text.includes('SUPABASE_SERVICE_ROLE_KEY'))
      .map(([path]) => path);
    expect(users).toContain('/src/lib/signups.ts');
    expect(users).toContain('/src/lib/notifications/db.ts');
    const allowed = (path: string) =>
      path === '/src/lib/signups.ts' ||
      path === '/src/env.d.ts' ||
      path.startsWith('/src/lib/notifications/');
    expect(users.filter((path) => !allowed(path))).toEqual([]);
  });

  it('reads RESEND_API_KEY only in src/lib/notifications; elsewhere only the env types and the banner name it', () => {
    const users = Object.entries(SRC)
      .filter(([, text]) => text.includes('RESEND_API_KEY'))
      .map(([path]) => path);
    const named = ['/src/env.d.ts', '/src/pages/admin/fragment.astro'];
    expect(users.filter((p) => !named.includes(p) && !p.startsWith('/src/lib/notifications/'))).toEqual([]);
    expect(SRC['/src/pages/admin/fragment.astro'].match(/RESEND_API_KEY/g)).toEqual(['RESEND_API_KEY']);
  });

  it('lists no secret in the wrangler.jsonc vars', () => {
    for (const secret of ['RESEND_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'BOT_API_TOKEN']) {
      expect(Object.keys(WRANGLER.vars)).not.toContain(secret);
    }
  });
});

describe('email notifications: the Worker entry (BR10.16, NFR8.3)', () => {
  it('wraps the built Astro handler with createWorker in three statements', () => {
    const entry = SRC['/src/worker/entry.ts'];
    expect(specifiers(entry)).toEqual([
      '../../dist/_worker.js/index.js',
      '../lib/notifications/run',
      '../lib/notifications/worker',
    ]);
    expect(entry).toContain('export default createWorker(astro, runNotifications);');
  });

  it('is imported by nothing, and no source or test imports the build output', () => {
    const all = { ...SRC, ...TESTS, ...SCRIPTS };
    expect(filesImporting(all, /(^|\/)(src\/)?worker\/(entry|astro-build)/)).toEqual([]);
    const fromSource = Object.fromEntries(
      Object.entries({ ...SRC, ...TESTS }).filter(([p]) => p !== '/src/worker/entry.ts'),
    );
    expect(filesImporting(fromSource, /(^|\/)dist\//)).toEqual([]);
    const library = Object.fromEntries(
      Object.entries(SRC).filter(([p]) => p.startsWith('/src/lib/notifications/')),
    );
    expect(filesImporting(library, /worker\/entry|dist\//)).toEqual([]);
  });

  it('keeps the entry out of astro check and type-checks it on its own after the build', () => {
    const tsconfig = JSON.parse(CONFIG['/tsconfig.json']) as { exclude: string[] };
    expect(tsconfig.exclude).toContain('src/worker');
    const worker = parseJsonc(CONFIG['/tsconfig.worker.json']) as {
      extends: string;
      include: string[];
      files: string[];
      compilerOptions: { allowJs: boolean; noEmit: boolean };
    };
    expect(worker).toMatchObject({
      extends: './tsconfig.json',
      include: [],
      compilerOptions: { allowJs: false, noEmit: true },
    });
    expect(worker.files).toEqual(['src/worker/entry.ts', 'src/worker/astro-build.d.ts']);
  });

  it('runs the worker type check after the build in CI and in the Deploy gates', () => {
    const check = 'npx tsc -p tsconfig.worker.json --noEmit';
    expect(CI.indexOf(check)).toBeGreaterThan(CI.indexOf('npm run build'));
    const gates = DEPLOY.slice(DEPLOY.indexOf('  gates:'), DEPLOY.indexOf('  drift-check:'));
    expect(gates.indexOf('npm run build')).toBeGreaterThan(-1);
    expect(gates.indexOf(check)).toBeGreaterThan(gates.indexOf('npm run build'));
  });
});

describe('email notifications: wrangler.jsonc (BR10.15, C9)', () => {
  it('points main at the wrapper and runs the cron every 15 minutes', () => {
    expect(WRANGLER.main).toBe('./src/worker/entry.ts');
    expect(WRANGLER.triggers?.crons).toEqual(['*/15 * * * *']);
  });

  it('lists every var the run reads, with the agreed values', () => {
    expect(WRANGLER.vars).toMatchObject({
      PUBLIC_SUPABASE_URL: expect.stringMatching(/^https:\/\//),
      EMAIL_FROM: 'Alpha Touring Challenge <noreply@alphatouringchallenge.com>',
      EMAIL_DAILY_CAP: '100',
      EMAIL_BATCH_SIZE: '50',
      SITE_URL: 'https://alphatouringchallenge.com',
    });
    expect(CONFIG['/wrangler.jsonc']).toMatch(
      /EMAIL_FROM is part of every batch's idempotent body, so\s+\/\/ do not change it/,
    );
  });
});

describe('email notifications: admin home counts (BR10.17, NFR9.3)', () => {
  const page = SRC['/src/pages/admin/fragment.astro'];

  it('loads the counts in parallel with the dashboard’s other reads', () => {
    // The page-level Promise.all, not the one inside loadCounts().
    const start = page.indexOf('\nawait Promise.all([');
    const parallel = page.slice(start, page.indexOf(']);', start));
    expect(parallel).toContain('loadCounts()');
    expect(parallel).toContain('getNotificationCounts(supabaseEnv, accessToken)');
  });

  it('shows the four counts, the "sending is off" banner and the unavailable message', () => {
    for (const label of [
      'Emails queued',
      'Dropped in the last 7 days',
      'because the daily cap was reached',
      'Delivery unknown in the last 7 days',
      'Enqueue failures in the last 7 days',
    ]) {
      expect(page).toContain(label);
    }
    expect(page).toMatch(
      /emailCounts\?\.sendingOff && \(\s*<p[^>]*>\s*Email sending is off: RESEND_API_KEY not set/,
    );
    expect(page).toContain('Email counts unavailable');
  });
});
