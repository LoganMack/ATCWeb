/**
 * Content-Security-Policy script allow-list. Every script the site runs is a
 * bundled file under /_astro (allowed by 'self') except the inline theme
 * script below, which has to run before the stylesheet paints. It is allowed
 * by its SHA-256 hash, so the text here and the hash must change together:
 *   node -e "console.log(require('crypto').createHash('sha256').update(TEXT).digest('base64'))"
 * scripts/check-csp.mjs fails if any inline script a page serves has no hash here.
 */

/** Adds the `light` class before first paint when the visitor chose light mode (see src/scripts/theme.ts). */
export const THEME_INIT_SCRIPT =
  "(function(){try{if(localStorage.getItem('atc-theme')==='light'){document.documentElement.classList.add('light');}}catch(e){}})();";

/** SHA-256 hashes (CSP source form) of every inline script the pages emit. */
export const INLINE_SCRIPT_HASHES = ["'sha256-FDHDzqBX1CFzWrXHO5kHw0x9YQmqcEnX6z7ypE+sLak='"];

/** Cloudflare Web Analytics, whose beacon the zone injects into every HTML page. */
const CLOUDFLARE_INSIGHTS_ORIGIN = 'https://static.cloudflareinsights.com';

/**
 * The full response CSP. No 'unsafe-inline' or 'unsafe-eval'. Our own scripts
 * never use the nonce; it exists for Cloudflare's Bot Fight Mode snippet,
 * which is injected at the edge with a per-request id (so it can't be hashed)
 * and copies the nonce from this header. Use a fresh one on every response,
 * cache hits included, or a cached page would publish a reusable nonce.
 */
export function contentSecurityPolicy(nonce: string): string {
  return [
    `script-src 'self' ${INLINE_SCRIPT_HASHES.join(' ')} 'nonce-${nonce}' ${CLOUDFLARE_INSIGHTS_ORIGIN}`,
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** 128 random bits, base64, for one response's CSP nonce. */
export function newCspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
