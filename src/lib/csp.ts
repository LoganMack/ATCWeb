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

/** The full response CSP. No 'unsafe-inline' or 'unsafe-eval'. */
export const CONTENT_SECURITY_POLICY = [
  `script-src 'self' ${INLINE_SCRIPT_HASHES.join(' ')}`,
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');
