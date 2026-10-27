/**
 * Kudos (0101_kudos.sql) — highlights from a round that anyone can read and
 * signed-in users can share, on src/pages/results/[subsessionId]/kudos.astro.
 * No review or status: a kudos is public as soon as it's shared, and only its
 * author or an admin can delete it.
 */

import { restGet, type SupabaseEnv } from './db/client';
import privacyReads from './privacyReads.json';

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
  if (v.length > KUDOS_CLIP_URL_MAX_LENGTH || !/^https?:\/\/\S+$/i.test(v))
    throw new Error('invalid clip link');
  try {
    new URL(v);
  } catch {
    throw new Error('invalid clip link');
  }
  return v;
}

/**
 * Public read — every kudos for the round with its cars, oldest first, from the masked kudos_shown (U4): the
 * author name reads "Hidden Driver" when the author's driver is hidden from this caller.
 */
export async function getKudosForSubsession(env: SupabaseEnv, subsessionId: number): Promise<Kudos[]> {
  const { path, select } = privacyReads.kudos;
  const rows = await restGet<(Omit<Kudos, 'driver_ids'> & { kudos_drivers: { driver_id: string }[] })[]>(
    env,
    `${path}?select=${encodeURIComponent(select)}&subsession_id=eq.${subsessionId}&order=created_at.asc`,
  );
  return rows.map(({ kudos_drivers, ...k }) => ({ ...k, driver_ids: kudos_drivers.map((d) => d.driver_id) }));
}

// --- Kudos across rounds (driver-profile-polish FR6, FR7) ----------------------------------------------

/** One car involved in a kudos, from drivers_shown: a hidden driver's name arrives masked and is_hidden set. */
export interface KudosCar {
  id: string;
  name: string;
  car_number: number | null;
  is_hidden: boolean;
}

/** A kudos with its cars in car-number order, for lists that span rounds (profile dialog, History > Kudos). */
export interface KudosEntry extends Omit<Kudos, 'driver_ids'> {
  cars: KudosCar[];
}

export interface KudosFeedRow extends Omit<Kudos, 'driver_ids'> {
  kudos_drivers: { driver_id: string; drivers: KudosCar | null }[];
  involved_match?: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** At most this many kudos per read: one page of a season, or one driver's dialog. */
export const KUDOS_FEED_LIMIT = 300;

/** Rows from the kudosFeed / kudosInvolving reads to entries; a car whose driver row is gone is dropped. */
export function toKudosEntries(rows: KudosFeedRow[]): KudosEntry[] {
  return rows.map(({ kudos_drivers, involved_match: _match, ...k }) => ({
    ...k,
    cars: kudos_drivers
      .map((link) => link.drivers)
      .filter((d): d is KudosCar => d !== null)
      .map((d) => ({ ...d, is_hidden: d.is_hidden === true }))
      .sort(
        (a, b) => (a.car_number ?? Infinity) - (b.car_number ?? Infinity) || a.name.localeCompare(b.name),
      ),
  }));
}

/** "Race 2", "Qualifying" or "Practice" for a kudos session value ("race:2"). */
export function kudosSessionLabel(session: string): string {
  const [type, num] = session.split(':');
  if (type === 'qualifying') return 'Qualifying';
  if (type === 'practice') return 'Practice';
  if (type === 'race') return num ? `Race ${num}` : 'Race';
  return session;
}

/** "youtube.com": just the host, for a clip link's label. */
export function kudosClipHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'clip';
  }
}

/**
 * Every kudos the driver is one of the cars involved in, newest first, from the masked kudos_shown. The
 * `!inner` alias filters to the driver while the plain embed still lists every car.
 */
export async function getKudosInvolvingDriver(env: SupabaseEnv, driverId: string): Promise<KudosEntry[]> {
  if (!UUID.test(driverId)) return [];
  const { path, select } = privacyReads.kudosInvolving;
  const rows = await restGet<KudosFeedRow[]>(
    env,
    `${path}?select=${encodeURIComponent(select)}&involved_match.driver_id=eq.${driverId}` +
      `&order=created_at.desc&limit=${KUDOS_FEED_LIMIT}`,
  );
  return toKudosEntries(rows);
}

/** Every kudos for these rounds (one season on History > Kudos), newest first, in one read. */
export async function getKudosForSubsessions(
  env: SupabaseEnv,
  subsessionIds: number[],
): Promise<KudosEntry[]> {
  const ids = [...new Set(subsessionIds)].filter((id) => Number.isSafeInteger(id));
  if (ids.length === 0) return [];
  const { path, select } = privacyReads.kudosFeed;
  const rows = await restGet<KudosFeedRow[]>(
    env,
    `${path}?select=${encodeURIComponent(select)}&subsession_id=in.(${ids.join(',')})` +
      `&order=created_at.desc&limit=${KUDOS_FEED_LIMIT}`,
  );
  return toKudosEntries(rows);
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
 * RLS allows only the author or an admin; its cars cascade. False when nothing was deleted (RLS filtering is
 * still a 2xx). Scoped to the page's round.
 */
export async function deleteKudos(
  env: SupabaseEnv,
  accessToken: string,
  subsessionId: number,
  kudosId: string,
): Promise<boolean> {
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
