/**
 * The single place any PUBLIC_* value is read from.
 *
 * Replaces the two near-identical resolvers this used to have
 * (`resolveSupabaseEnv` in lib/supabase.ts and `resolveSiteLinks` in
 * lib/links.ts), which had drifted into duplicating the same fallback logic
 * and the same unnecessary cast.
 *
 * WHY THE FALLBACK EXISTS — this is the bug that once broke every page in
 * production, so it's worth keeping straight:
 *
 *   - `import.meta.env.PUBLIC_*` is baked in at BUILD time. It's the right
 *     source for local `astro dev` and for genuinely prerendered pages.
 *   - `wrangler.jsonc`'s `vars` (and anything bound to the Worker in the
 *     Cloudflare dashboard) are a RUNTIME concept — only visible via
 *     `Astro.locals.runtime.env`, and only once the Worker is actually
 *     handling a request.
 *
 * Every page in this project is `prerender = false`, so in production the
 * runtime binding is the real source and `import.meta.env` is `undefined`.
 * Runtime wins; the build-time value is the fallback.
 *
 * IMPORTANT — do not "tidy" the `import.meta.env.PUBLIC_X` reads below into
 * a dynamic lookup like `import.meta.env[key]`. Vite only substitutes these
 * values for *literal* property accesses at build time; an indexed read
 * silently resolves to `undefined` and puts you right back in the original
 * bug.
 */

export interface SiteEnv {
  supabaseUrl: string;
  supabaseAnonKey: string;
  discordUrl: string;
  redbubbleUrl: string;
}

export function resolveEnv(locals: App.Locals): SiteEnv {
  // `App.Locals extends Runtime` types `runtime.env` as always-present, but
  // it genuinely is undefined outside a Worker request (plain `astro dev`
  // without the platform proxy, or a prerendered page) — hence the `?.`.
  const runtime = locals.runtime?.env;

  return {
    supabaseUrl: runtime?.PUBLIC_SUPABASE_URL || import.meta.env.PUBLIC_SUPABASE_URL || '',
    supabaseAnonKey: runtime?.PUBLIC_SUPABASE_ANON_KEY || import.meta.env.PUBLIC_SUPABASE_ANON_KEY || '',
    discordUrl: runtime?.PUBLIC_DISCORD_URL || import.meta.env.PUBLIC_DISCORD_URL || '',
    redbubbleUrl: runtime?.PUBLIC_REDBUBBLE_URL || import.meta.env.PUBLIC_REDBUBBLE_URL || '',
  };
}
