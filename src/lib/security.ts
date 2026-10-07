/**
 * Small, dependency-free security helpers shared across pages and API
 * routes. Everything here is deliberately conservative.
 */

/**
 * Returns a same-site relative path that is safe to hand to a redirect, or
 * `fallback` if `raw` is anything else. `next` / `redirect` style values come
 * straight from the query string or a form field, so they are attacker
 * controlled — a link like /login?next=https://evil.example would otherwise
 * send a freshly signed-in user to a phishing page.
 *
 * Rejects: absolute URLs, protocol-relative (`//host`), backslash tricks
 * (`/\host` — browsers treat `\` as `/`), and any control character
 * (tab/newline get stripped by URL parsers, which can turn `/\t/host` into
 * `//host`).
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
 * JSON.stringify for embedding inside a <script type="application/json">
 * block via `set:html`. Plain JSON.stringify leaves `</script>` intact, so a
 * driver name or news title containing it would break out of the tag and run
 * as HTML. Escaping `<`, `>`, `&` and the two JS line-separator characters
 * keeps the JSON identical when parsed but inert as markup.
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
