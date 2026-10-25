// Refuses whole-site sweeps against production Supabase unless --allow-production is passed. A sweep from
// a local build reads every page straight from Supabase with no edge cache, so a few passes can use more
// than the Free plan's monthly egress.
// Dependency-free: Node built-ins only.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOW_PRODUCTION_FLAG = '--allow-production';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', 'host.docker.internal']);

/** True for a URL on this machine (a local Worker or `supabase start`); anything else counts as hosted. */
export function isLocalUrl(url) {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The value of `name` in a .dev.vars file (KEY=value lines), or null. */
export function devVarsValue(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && match[1] === name) return match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return null;
}

/** The value of `name` in wrangler.jsonc's text, or null. */
export function wranglerValue(text, name) {
  return new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`).exec(text)?.[1] ?? null;
}

function readOrEmpty(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** The Supabase URL a local `wrangler dev` talks to: .dev.vars overrides the vars in wrangler.jsonc. */
export function localWorkerSupabaseUrl(root = ROOT) {
  return (
    devVarsValue(readOrEmpty(path.join(root, '.dev.vars')), 'PUBLIC_SUPABASE_URL') ??
    wranglerValue(readOrEmpty(path.join(root, 'wrangler.jsonc')), 'PUBLIC_SUPABASE_URL')
  );
}

/**
 * Null when the sweep may run, otherwise why not. `siteUrl` is the site being swept (null when the
 * script reads Supabase itself); `supabaseUrl` is the Supabase that site, or the script, reads;
 * `overrideIn` says where that URL is set.
 * @param {{ siteUrl?: string | null, supabaseUrl: string | null, allowed: boolean, overrideIn?: string }} options
 * @returns {string | null}
 */
export function sweepRefusal({ siteUrl = null, supabaseUrl, allowed, overrideIn = 'in .dev.vars' }) {
  if (allowed) return null;
  const how = `pass ${ALLOW_PRODUCTION_FLAG} to run it anyway`;
  if (siteUrl && !isLocalUrl(siteUrl)) {
    return `refusing to sweep ${siteUrl}: it reads production Supabase, and a whole-site sweep can use the Free plan's monthly egress in hours; ${how}`;
  }
  if (!supabaseUrl || !isLocalUrl(supabaseUrl)) {
    return (
      `refusing a whole-site sweep against ${supabaseUrl ?? 'an unknown Supabase'}: it reads straight from Supabase with no ` +
      `edge cache, which can use the Free plan's monthly egress in hours. Point PUBLIC_SUPABASE_URL ` +
      `(and PUBLIC_SUPABASE_ANON_KEY) at a local Supabase (npx supabase start) ${overrideIn}, or ${how}`
    );
  }
  return null;
}
