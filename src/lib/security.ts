/**
 * Small, dependency-free security helpers shared across pages and API
 * routes. Everything here is deliberately conservative.
 */

/**
 * A same-site relative path safe to redirect to, else `fallback`. `next` values are attacker-controlled (open
 * redirect to phishing). Rejects absolute and protocol-relative URLs, `/\host` (browsers read `\` as `/`) and
 * control characters (stripped by URL parsers, turning `/\t/host` into `//host`).
 */
export function safeNext(raw: string | null | undefined, fallback = '/'): string {
  if (!raw || typeof raw !== 'string') return fallback;
  if (raw.length > 2000) return fallback;
  if (!raw.startsWith('/')) return fallback;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;
  try {
    // Must resolve to the same origin when parsed against a dummy base.
    const base = 'http://atc.invalid';
    const u = new URL(raw, base);
    if (u.origin !== base) return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}

/**
 * JSON.stringify for a <script type="application/json"> via `set:html`: escaping `<`, `>`, `&` and U+2028/9
 * keeps the JSON the same but stops a `</script>` in data breaking out.
 */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** HTML-escape text for use inside an HTML string built in client code. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The only text a visitor sees when a data load fails. Backend errors carry
 * status codes, query paths and schema hints, so they go to the server log
 * (console.error) and never into public markup.
 */
export function publicLoadErrorMessage(): string {
  return "We couldn't load this right now. Please try again shortly.";
}

/**
 * Marks this render as a failed load: the browser gets no-store now, and the
 * middleware forces no-store again after the page sets its own header and
 * keeps the response out of the edge cache, so a failure is never served to
 * the next visitor.
 */
export function markUncacheable(astro: { locals: App.Locals; response: { headers: Headers } }): void {
  astro.locals.uncacheable = true;
  astro.response.headers.set('Cache-Control', 'no-store');
}

/** True only for http(s) URLs — blocks javascript:, data: etc. */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
