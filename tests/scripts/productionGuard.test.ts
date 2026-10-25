/**
 * The guard that stops snapshot-pages and compare-round-stats sweeping production Supabase by accident.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  devVarsValue,
  isLocalUrl,
  localWorkerSupabaseUrl,
  sweepRefusal,
  wranglerValue,
} from '../../scripts/productionGuard.mjs';

const PROD = 'https://hqatqfftlmqmjtusyfhz.supabase.co';
const LOCAL = 'http://127.0.0.1:54321';

describe('isLocalUrl', () => {
  it('accepts this machine and rejects hosted or broken URLs', () => {
    expect(isLocalUrl('http://localhost:8787')).toBe(true);
    expect(isLocalUrl(LOCAL)).toBe(true);
    expect(isLocalUrl('http://[::1]:8787')).toBe(true);
    expect(isLocalUrl(PROD)).toBe(false);
    expect(isLocalUrl('https://alphatouringchallenge.com')).toBe(false);
    expect(isLocalUrl('not a url')).toBe(false);
  });
});

describe('sweepRefusal', () => {
  it('refuses a local Worker that reads production Supabase', () => {
    const refusal = sweepRefusal({ siteUrl: 'http://localhost:8787', supabaseUrl: PROD, allowed: false });
    expect(refusal).toContain(PROD);
    expect(refusal).toContain('--allow-production');
  });

  it('refuses the live site even when the local Worker would read a local Supabase', () => {
    const refusal = sweepRefusal({
      siteUrl: 'https://alphatouringchallenge.com',
      supabaseUrl: LOCAL,
      allowed: false,
    });
    expect(refusal).toContain('alphatouringchallenge.com');
  });

  it('refuses when the Supabase URL is unknown', () => {
    expect(sweepRefusal({ supabaseUrl: null, allowed: false })).toContain('an unknown Supabase');
  });

  it('allows a local site on a local Supabase, and anything with the flag', () => {
    expect(sweepRefusal({ siteUrl: 'http://localhost:8787', supabaseUrl: LOCAL, allowed: false })).toBeNull();
    expect(sweepRefusal({ supabaseUrl: LOCAL, allowed: false })).toBeNull();
    expect(sweepRefusal({ siteUrl: 'http://localhost:8787', supabaseUrl: PROD, allowed: true })).toBeNull();
  });

  it('names where the URL is set', () => {
    expect(sweepRefusal({ supabaseUrl: PROD, allowed: false, overrideIn: 'in the environment' })).toContain(
      'in the environment',
    );
  });
});

describe('reading the Worker’s Supabase URL', () => {
  it('reads .dev.vars lines, with or without quotes', () => {
    expect(devVarsValue('# c\nPUBLIC_SUPABASE_URL="http://127.0.0.1:54321"\n', 'PUBLIC_SUPABASE_URL')).toBe(
      LOCAL,
    );
    expect(devVarsValue('PUBLIC_SUPABASE_URL = http://localhost:54321\r\n', 'PUBLIC_SUPABASE_URL')).toBe(
      'http://localhost:54321',
    );
    expect(devVarsValue('OTHER=1', 'PUBLIC_SUPABASE_URL')).toBeNull();
  });

  it('reads wrangler.jsonc vars', () => {
    expect(wranglerValue(`{ "vars": { "PUBLIC_SUPABASE_URL": "${PROD}" } }`, 'PUBLIC_SUPABASE_URL')).toBe(
      PROD,
    );
  });

  it('prefers .dev.vars over wrangler.jsonc, and falls back to wrangler.jsonc', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'guard-'));
    writeFileSync(path.join(root, 'wrangler.jsonc'), `{ "vars": { "PUBLIC_SUPABASE_URL": "${PROD}" } }`);
    expect(localWorkerSupabaseUrl(root)).toBe(PROD);
    writeFileSync(path.join(root, '.dev.vars'), `PUBLIC_SUPABASE_URL=${LOCAL}\n`);
    expect(localWorkerSupabaseUrl(root)).toBe(LOCAL);
  });

  it('reads production from this repository’s own wrangler.jsonc', () => {
    // Guards the default: with no .dev.vars, a local Worker reads production.
    expect(wranglerValue(readFileSync('wrangler.jsonc', 'utf8'), 'PUBLIC_SUPABASE_URL')).toMatch(
      /^https:\/\/[a-z0-9]+\.supabase\.co$/,
    );
  });
});
