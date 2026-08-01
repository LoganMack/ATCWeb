/**
 * Discord/Redbubble URLs — same runtime-vs-build-time issue that originally
 * broke the roster/news pages (see the README's "Why the roster/news
 * actually failed to load in production" note and src/lib/supabase.ts).
 * Nav.astro and Footer.astro render on every page, and every page in this
 * project has `export const prerender = false`, meaning they run per-request
 * on Cloudflare's Worker — where `import.meta.env.PUBLIC_*` is undefined
 * (it's only ever baked in at *build* time). Reading it directly there made
 * every Discord/Merch/Sign Up link render with no `href` at all — inert,
 * not just wrong. This resolves the runtime binding first, same pattern as
 * `resolveSupabaseEnv`.
 */

export interface SiteLinks {
  discordUrl: string;
  redbubbleUrl: string;
}

export function resolveSiteLinks(locals: App.Locals): SiteLinks {
  const runtimeEnv = (locals as { runtime?: { env?: Record<string, string> } } | undefined)?.runtime?.env;
  return {
    discordUrl: runtimeEnv?.PUBLIC_DISCORD_URL || import.meta.env.PUBLIC_DISCORD_URL,
    redbubbleUrl: runtimeEnv?.PUBLIC_REDBUBBLE_URL || import.meta.env.PUBLIC_REDBUBBLE_URL,
  };
}
