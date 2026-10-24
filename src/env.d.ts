/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_SUPABASE_URL: string;
  readonly PUBLIC_SUPABASE_ANON_KEY: string;
  readonly PUBLIC_DISCORD_URL: string;
  readonly PUBLIC_REDBUBBLE_URL: string;
  /** Server-only secrets for the Discord bot API (src/lib/signups.ts). Optional: unset just disables those endpoints. */
  readonly BOT_API_TOKEN?: string;
  readonly SUPABASE_SERVICE_ROLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Cloudflare Worker runtime bindings, matching wrangler.jsonc "vars"; read at request time via
// Astro.locals.runtime.env (see resolveSupabaseEnv in src/lib/db/client.ts).
type CloudflareRuntimeEnv = {
  PUBLIC_SUPABASE_URL: string;
  PUBLIC_SUPABASE_ANON_KEY: string;
  PUBLIC_DISCORD_URL: string;
  PUBLIC_REDBUBBLE_URL: string;
  // Email notifications (src/lib/notifications); read by the scheduled run, not by pages.
  EMAIL_FROM: string;
  EMAIL_DAILY_CAP: string;
  EMAIL_BATCH_SIZE: string;
  SITE_URL: string;
  // Cloudflare secrets (`wrangler secret put`), not wrangler.jsonc vars.
  BOT_API_TOKEN?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  RESEND_API_KEY?: string;
};

type Runtime = import('@astrojs/cloudflare').Runtime<CloudflareRuntimeEnv>;

// Set by src/middleware.ts from the atc_at/atc_rt cookies. `profile` stays nullable in case a session has no
// `profiles` row.
type Session = {
  user: import('./lib/auth').AuthUser;
  profile: import('./lib/auth').Profile | null;
  accessToken: string;
} | null;

declare namespace App {
  interface Locals extends Runtime {
    session: Session;
    /** True when `session` belongs to an actual admin — independent of `viewAsVisitor` below, so the footer's toggle (see Footer.astro) can always find its way back even mid-preview. Set once by src/middleware.ts on every request. */
    isRealAdmin: boolean;
    /**
     * True while a real admin uses "View as Visitor" (`atc_view_mode`). Admin UI outside /admin checks
     * `isAdminView(Astro.locals)` so the toggle hides it; /admin itself gates on the real role, so an admin
     * is never locked out.
     */
    viewAsVisitor: boolean;
    /** viewAsVisitor outside /admin: resolveSupabaseEnv then reads without the session's token (U4). */
    readAsVisitor?: boolean;
    /** True when the visitor has "View as Broadcaster" on (`atc_broadcaster` cookie) — see src/lib/auth.ts's BROADCASTER_COOKIE. */
    broadcasterMode: boolean;
    /** Subsession id(s) hidden from every subsession-keyed read while `broadcasterMode` is on (the most recent round). Carried onto SupabaseEnv by resolveSupabaseEnv. */
    broadcasterHiddenSubsessionIds?: number[];
    /** Set by markUncacheable (src/lib/security.ts) when a render hit a data-load failure; the middleware then sends no-store and skips the edge cache. */
    uncacheable?: boolean;
    /** This request's memo of reference reads (src/lib/requestMemo.ts), created by src/middleware.ts. */
    memo?: import('./lib/requestMemo').RequestMemo;
    /** REST reads made by this request; set only under `wrangler dev` and sent back as X-ATC-Subrequests. */
    subrequestCounter?: { count: number };
  }
}
