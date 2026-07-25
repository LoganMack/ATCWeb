/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_SUPABASE_URL: string;
  readonly PUBLIC_SUPABASE_ANON_KEY: string;
  readonly PUBLIC_DISCORD_URL: string;
  readonly PUBLIC_REDBUBBLE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Cloudflare Worker runtime bindings — matches wrangler.jsonc's "vars".
// Available at request time via Astro.locals.runtime.env on any
// `prerender = false` page/endpoint. See src/lib/env.ts for why this is the
// source these values actually need to come from in production.
type CloudflareRuntimeEnv = {
  PUBLIC_SUPABASE_URL: string;
  PUBLIC_SUPABASE_ANON_KEY: string;
  PUBLIC_DISCORD_URL: string;
  PUBLIC_REDBUBBLE_URL: string;
};

type Runtime = import('@astrojs/cloudflare').Runtime<CloudflareRuntimeEnv>;

// Populated by src/middleware.ts on every on-demand request from the
// atc_at/atc_rt cookies. `profile` is null for a valid auth session that
// somehow has no matching `profiles` row (shouldn't happen given the
// on_auth_user_created trigger in 0002_auth_admin.sql, but keep it nullable
// rather than assume).
type Session = {
  user: { id: string; email: string | null };
  profile: import('./lib/db/types').Profile | null;
  accessToken: string;
} | null;

declare namespace App {
  interface Locals extends Runtime {
    session: Session;
    /**
     * Per-request data access, built in src/middleware.ts and already bound
     * to the resolved env plus the signed-in user's token (if any). Pages
     * use this instead of constructing a client themselves — see
     * src/lib/db/index.ts.
     *
     * TYPED AS ALWAYS-PRESENT, WHICH ASSUMES ON-DEMAND RENDERING. Middleware
     * doesn't run for prerendered pages, so this is genuinely `undefined`
     * on any page that omits `export const prerender = false`. Every route
     * in src/pages currently sets it. If you add one that doesn't and it
     * needs data, either mark it on-demand or fetch at build time with an
     * explicitly-constructed client (`createDb(resolveEnv(...), null)`)
     * rather than reaching for this.
     */
    db: import('./lib/db').Db;
  }
}
