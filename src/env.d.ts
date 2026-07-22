/// <reference path="../.astro/types.d.ts" />
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
// `prerender = false` page/endpoint. See src/lib/supabase.ts for why this
// is the mechanism these values actually need to come from in production.
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
  profile: import('./lib/auth').Profile | null;
  accessToken: string;
} | null;

declare namespace App {
  interface Locals extends Runtime {
    session: Session;
  }
}
