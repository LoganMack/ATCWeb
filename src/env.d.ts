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

declare namespace App {
  interface Locals extends Runtime {}
}
