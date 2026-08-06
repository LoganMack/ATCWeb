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
    /** True when `session` belongs to an actual admin — independent of `viewAsVisitor` below, so the footer's toggle (see Footer.astro) can always find its way back even mid-preview. Set once by src/middleware.ts on every request. */
    isRealAdmin: boolean;
    /**
     * True when a real admin has flipped on "View as Visitor" (footer
     * toggle, `atc_view_mode` cookie) to preview the site the way a
     * non-admin would see it. Every admin-gated page/component OUTSIDE of
     * /admin itself should check `isAdminView(Astro.locals)` (src/lib/
     * auth.ts) instead of `session?.profile?.role === 'admin'` directly, so
     * this toggle actually hides their admin-only UI. /admin/* pages are
     * unaffected on purpose — middleware's route gate keys off the real
     * role, so a real admin never gets locked out of the admin panel itself
     * just for previewing the public site as a visitor.
     */
    viewAsVisitor: boolean;
  }
}
