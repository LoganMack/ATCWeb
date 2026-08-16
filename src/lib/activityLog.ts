/**
 * Admin Activity Log (/admin/activity-log) — one best-effort write per
 * admin-side mutation across the site. Built on restPost (see supabase.ts's
 * "Storage"/raceResultsImport.ts-style one-off exception note) rather than a
 * dedicated per-table wrapper, since every call site here already has an
 * `env`/`accessToken` on hand and a single small helper is simpler than a
 * full CRUD surface for a table nothing ever reads back except the log page
 * itself (src/pages/admin/activity-log/index.astro, via restGetAuthed).
 *
 * Every call site follows the same two-line shape:
 *   await logActivity(supabaseEnv, accessToken, actorName, {
 *     action: 'edit', entity_type: 'driver', entity_label: driver.name, entity_id: driver.id,
 *   });
 * placed right after the mutation it's describing succeeds — never before,
 * so a failed mutation never produces a misleading log entry. logActivity
 * itself never throws: a broken log write is a UX regression on one new
 * admin tab, not a reason to fail (or worse, appear to fail while actually
 * succeeding) the real action underneath it.
 */
import { restPost, type SupabaseEnv } from './supabase';

export type ActivityAction = 'add' | 'edit' | 'delete';

export interface ActivityLogRow {
  id: string;
  created_at: string;
  actor_id: string | null;
  actor_name: string;
  action: ActivityAction;
  entity_type: string;
  entity_label: string | null;
  entity_id: string | null;
  details: string | null;
  file_url: string | null;
  file_name: string | null;
}

export interface LogActivityInput {
  action: ActivityAction;
  /** e.g. 'driver', 'team', 'event', 'circuit', 'organization', 'ruleset', 'season', 'incident', 'photo', 'site_property', 'user', 'import'. Free text on purpose — see 0051_activity_log.sql's header for why this isn't a check()-constrained enum. */
  entity_type: string;
  /** Human-readable "what" — a driver's name, a site setting's key, a season's name, etc. Shown as the main line of the log row. */
  entity_label?: string | null;
  entity_id?: string | number | null;
  /** Freeform extra context shown as a secondary line — e.g. which ruleset a recalculation used, which role a user was changed to, which property changed and its new value. */
  details?: string | null;
  /** Only meaningful for entity_type: 'import' — a public URL (in the 'imports' Storage bucket) back to the exact spreadsheet that was uploaded, so the log row can offer a direct download. */
  file_url?: string | null;
  file_name?: string | null;
}

/**
 * Resolves the "who did this" label the exact same way AdminLayout.astro's
 * header does (`session?.profile?.display_name || session?.user.email`), so
 * an activity_log row reads as the same name the admin sees for themselves
 * everywhere else in the panel.
 */
export function actorNameFor(session: { profile?: { display_name: string | null } | null; user: { email: string | null } }): string {
  return session.profile?.display_name || session.user.email || 'Unknown';
}

/**
 * Writes one activity_log row for the given actor (accessToken's own user —
 * RLS requires actor_id = auth.uid() unless the actor is an admin, see
 * 0051_activity_log.sql). Swallows and logs any failure rather than
 * throwing — see this file's header comment for why.
 */
export async function logActivity(
  env: SupabaseEnv,
  accessToken: string,
  actor: { id: string; name: string },
  input: LogActivityInput
): Promise<void> {
  try {
    await restPost(env, accessToken, 'activity_log', {
      actor_id: actor.id,
      actor_name: actor.name,
      action: input.action,
      entity_type: input.entity_type,
      entity_label: input.entity_label ?? null,
      entity_id: input.entity_id != null ? String(input.entity_id) : null,
      details: input.details ?? null,
      file_url: input.file_url ?? null,
      file_name: input.file_name ?? null,
    });
  } catch (err) {
    console.error('Failed to write activity_log entry:', err);
  }
}
