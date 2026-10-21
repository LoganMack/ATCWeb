import type { SupabaseEnv } from '../db/client';

/** What every incident action returns; the page answers with `Astro.redirect(location, status)`. */
export interface IncidentActionRedirect {
  location: string;
  status: 302;
}

/**
 * What an incident action gets in place of the page's `Astro` global and frontmatter values, so the
 * handlers can live in src/lib.
 */
export interface IncidentActionContext {
  supabaseEnv: SupabaseEnv;
  subsessionId: number;
  /** The visible page every POST redirects back to, not the fragment URL. */
  shellPath: string;
  url: URL;
  /** Read by submit-appeal. */
  session: App.Locals['session'];
  /** The admin intents' fields: the page sets them only after it has found an admin session. */
  accessToken: string;
  actor: { id: string; name: string };
  roundLabel: string;
  /** Always `{ location, status: 302 }`. */
  redirect: (location: string) => IncidentActionRedirect;
}
