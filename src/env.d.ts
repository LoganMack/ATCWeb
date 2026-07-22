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
