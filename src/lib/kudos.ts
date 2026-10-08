/**
 * Kudos (0101_kudos.sql) — highlights from a round that anyone can read and
 * signed-in users can share, on src/pages/results/[subsessionId]/kudos.astro.
 * No review or status: a kudos is public as soon as it's shared, and only its
 * author or an admin can delete it.
 */

import { restGet, type SupabaseEnv } from './supabase';

export interface Kudos {
  id: string;
  subsession_id: number;
  /** 'race:N' | 'qualifying:0' | 'practice:0' — same as incident reports. */
  session: string;
  lap: number;
  turn: string;
  description: string | null;
  clip_url: string | null;
  author_id: string;
  /** Linked driver's name, else display name; null if the user has neither. */
  author_name: string | null;
  created_at: string;
  driver_ids: string[];
}

export interface NewKudos {
  subsession_id: number;
  session: string;
  lap: number;
  turn: string;
  description: string | null;
  clip_url: string | null;
  driver_ids: string[];
}

export const KUDOS_CLIP_URL_MAX_LENGTH = 500;
/** Same cap as submit_kudos (0101) — anything past it is a typo, not a lap. */
export const KUDOS_MAX_LAP = 10000;

/** The clip link, trimmed, or null when blank. Throws on anything that isn't an http(s) URL (submit_kudos re-checks). */
export function normalizeClipUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (v.length > KUDOS_CLIP_URL_MAX_LENGTH || !/^https?:\/\/\S+$/i.test(v)) throw new Error('invalid clip link');
  try {
    new URL(v);
  } catch {
    throw new Error('invalid clip link');
  }
  return v;
}

/** Public read — every kudos for the round with its cars, oldest first. */
export async function getKudosForSubsession(env: SupabaseEnv, subsessionId: number): Promise<Kudos[]> {
  const rows = await restGet<(Omit<Kudos, 'driver_ids'> & { kudos_drivers: { driver_id: string }[] })[]>(
    env,
    `kudos?select=*,kudos_drivers(driver_id)&subsession_id=eq.${subsessionId}&order=created_at.asc`
  );
  return rows.map(({ kudos_drivers, ...k }) => ({ ...k, driver_ids: kudos_drivers.map((d) => d.driver_id) }));
}

/**
 * Signed-in users only: goes through the submit_kudos SECURITY DEFINER
 * function (0101), which validates the input and derives the author from the
 * caller's JWT. Throws on any failure.
 */
export async function createKudos(env: SupabaseEnv, accessToken: string, input: NewKudos): Promise<void> {
  const res = await fetch(`${env.url}/rest/v1/rpc/submit_kudos`, {
    method: 'POST',
    headers: {
      apikey: env.anonKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_subsession_id: input.subsession_id,
      p_session: input.session,
      p_lap: input.lap,
      p_turn: input.turn,
      p_description: input.description,
      p_clip_url: input.clip_url,
      p_driver_ids: input.driver_ids,
    }),
  });
  if (!res.ok) throw new Error(`Supabase rpc error ${res.status} on submit_kudos: ${await res.text()}`);
}

/**
 * RLS limits this to the kudos' author or an admin; its cars go with it (on
 * delete cascade). Returns false when nothing was deleted — RLS filtering a
 * row out (or it already being gone) is still a 2xx from PostgREST. Scoped to
 * the round whose page the Delete came from; a malformed id deletes nothing.
 */
export async function deleteKudos(env: SupabaseEnv, accessToken: string, subsessionId: number, kudosId: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(kudosId)) return false;
  const res = await fetch(`${env.url}/rest/v1/kudos?id=eq.${kudosId}&subsession_id=eq.${subsessionId}`, {
    method: 'DELETE',
    headers: {
      apikey: env.anonKey,
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'return=representation',
    },
  });
  if (!res.ok) throw new Error(`Supabase delete error ${res.status} on kudos: ${await res.text()}`);
  return ((await res.json()) as unknown[]).length > 0;
}

/** Cuts to `max` characters without splitting an emoji (a surrogate pair) in half. */
export function truncateChars(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('') : s;
}
