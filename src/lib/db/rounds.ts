import { isHttpUrl } from '../security';
import { restGet, restGetAll, writeHeaders, type SupabaseEnv } from './client';
import { memoized } from '../requestMemo';

// --- Round overrides (flag an individual round as a non-points exhibition) -

export interface RoundOverride {
  subsession_id: number;
  is_exhibition: boolean;
  /** 0036_round_test_flag.sql — independent of is_exhibition, see that migration's own comment for why these are two separate booleans rather than one category column. */
  is_test: boolean;
  note: string | null;
}

/** subsession_ids flagged as a non-points exhibition — used to exclude those rounds from standings/champions even inside an otherwise-real championship season. */
export function getExhibitionRoundIds(env: SupabaseEnv): Promise<Set<number>> {
  return memoized(env, 'getExhibitionRoundIds', [], async () => {
    const rows = await restGet<{ subsession_id: number }[]>(
      env,
      'round_overrides?select=subsession_id&is_exhibition=eq.true',
    );
    return new Set(rows.map((r) => r.subsession_id));
  });
}

/** subsession_ids flagged as a test round (0036_round_test_flag.sql) — used by the results list page's Test Sessions filter, same shape as getExhibitionRoundIds. */
export function getTestRoundIds(env: SupabaseEnv): Promise<Set<number>> {
  return memoized(env, 'getTestRoundIds', [], async () => {
    const rows = await restGet<{ subsession_id: number }[]>(
      env,
      'round_overrides?select=subsession_id&is_test=eq.true',
    );
    return new Set(rows.map((r) => r.subsession_id));
  });
}

/**
 * Exhibition- and test-flagged round ids together: every round excluded from standings, champions and career
 * stats (Logan). The flags stay separate (0036) for the Exhibition/Test badges, which read
 * getExhibitionRoundIds/getTestRoundIds.
 */
export function getStandingsExcludedRoundIds(env: SupabaseEnv): Promise<Set<number>> {
  return memoized(env, 'getStandingsExcludedRoundIds', [], async () => {
    const [exhibition, test] = await Promise.all([getExhibitionRoundIds(env), getTestRoundIds(env)]);
    return new Set([...exhibition, ...test]);
  });
}

/**
 * Sets one round's is_exhibition flag (upsert on subsession_id), leaving is_test alone (0036). Unused: the
 * flags now come from the linked event's category at import (Logan); kept for a future admin flow.
 */
export async function setRoundExhibition(
  env: SupabaseEnv,
  accessToken: string,
  subsessionId: number,
  isExhibition: boolean,
) {
  const res = await fetch(`${env.url}/rest/v1/round_overrides?on_conflict=subsession_id`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, { Prefer: 'return=representation,resolution=merge-duplicates' }),
    body: JSON.stringify({ subsession_id: subsessionId, is_exhibition: isExhibition }),
  });
  if (!res.ok) throw new Error(`Supabase upsert error ${res.status} on round_overrides: ${await res.text()}`);
  const rows = (await res.json()) as RoundOverride[];
  return rows[0];
}

/** Marks (or unmarks) one round as a test round — same upsert shape as setRoundExhibition, independent flag. Same "no longer called from the round page" note applies — see setRoundExhibition's own doc comment. */
export async function setRoundTest(
  env: SupabaseEnv,
  accessToken: string,
  subsessionId: number,
  isTest: boolean,
) {
  const res = await fetch(`${env.url}/rest/v1/round_overrides?on_conflict=subsession_id`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, { Prefer: 'return=representation,resolution=merge-duplicates' }),
    body: JSON.stringify({ subsession_id: subsessionId, is_test: isTest }),
  });
  if (!res.ok) throw new Error(`Supabase upsert error ${res.status} on round_overrides: ${await res.text()}`);
  const rows = (await res.json()) as RoundOverride[];
  return rows[0];
}

// --- Race links (iRacing results / replay download / broadcast video, per race) -

export interface RaceLinks {
  subsession_id: number;
  race_number: number;
  iracing_subsession_id: number | null;
  replay_url: string | null;
  broadcast_url: string | null;
  /** The stewards' published incident report for this round (rule 51) — usually applies to the whole round rather than one specific race, but lives here since race_links is already the per-race external-link table and a round only rarely splits its report by race. */
  incident_report_url: string | null;
  /** Wherever the series photographer's album for this specific race lives (0025_race_links_photo_album.sql) — e.g. a Flickr album. */
  photo_album_url: string | null;
}

const RACE_LINKS_SELECT =
  'subsession_id,race_number,iracing_subsession_id,replay_url,broadcast_url,incident_report_url,photo_album_url';

/** Every race's links for one round, keyed by race_number. */
export async function getRaceLinksForSubsession(
  env: SupabaseEnv,
  subsessionId: number,
): Promise<Map<number, RaceLinks>> {
  const rows = await restGet<RaceLinks[]>(
    env,
    `race_links?select=${RACE_LINKS_SELECT}&subsession_id=eq.${subsessionId}`,
  );
  return new Map(rows.map((r) => [r.race_number, r]));
}

/**
 * Every race's links across the given rounds in one query, for the Event Briefing's past rounds. No query for
 * an empty list.
 */
export async function getRaceLinksForSubsessions(
  env: SupabaseEnv,
  subsessionIds: number[],
): Promise<RaceLinks[]> {
  if (subsessionIds.length === 0) return [];
  return restGetAll<RaceLinks>(
    env,
    `race_links?select=${RACE_LINKS_SELECT}&subsession_id=in.(${subsessionIds.join(',')})`,
  );
}

/**
 * race_links rows with a broadcast_url, for the Media page's Broadcasts filter; getAllBroadcastVideos()
 * (src/lib/results/broadcasts.ts) adds the round context.
 */
export function getAllBroadcastRaceLinks(env: SupabaseEnv): Promise<RaceLinks[]> {
  return restGetAll<RaceLinks>(env, `race_links?select=${RACE_LINKS_SELECT}&broadcast_url=not.is.null`);
}

/**
 * race_links rows with a photo_album_url, for the Media page's Graphics tab; joined with rounds by
 * getAllPhotoAlbumLinks() (src/lib/results/broadcasts.ts).
 */
export function getAllPhotoAlbumRaceLinks(env: SupabaseEnv): Promise<RaceLinks[]> {
  return restGetAll<RaceLinks>(env, `race_links?select=${RACE_LINKS_SELECT}&photo_album_url=not.is.null`);
}

/**
 * race_links rows with a replay_url, for the Media page's Replays tab; joined by getAllReplayLinks()
 * (src/lib/results/broadcasts.ts).
 */
export function getAllReplayRaceLinks(env: SupabaseEnv): Promise<RaceLinks[]> {
  return restGetAll<RaceLinks>(env, `race_links?select=${RACE_LINKS_SELECT}&replay_url=not.is.null`);
}

export const RACE_LINK_URL_FIELDS = [
  'replay_url',
  'broadcast_url',
  'incident_report_url',
  'photo_album_url',
] as const;
export type RaceLinkUrlField = (typeof RACE_LINK_URL_FIELDS)[number];

/** The first link field holding something other than an http(s) URL (blocks javascript:, data: etc.), or null. */
export function invalidRaceLinkField(
  data: Partial<Record<RaceLinkUrlField, string | null>>,
): RaceLinkUrlField | null {
  for (const field of RACE_LINK_URL_FIELDS) {
    const value = data[field];
    if (value != null && !isHttpUrl(value)) return field;
  }
  return null;
}

/** Upserts one race's links — replaces whatever was set for that (subsession_id, race_number) before. Any field left undefined stays whatever it already was; pass null explicitly to clear a field. */
export async function upsertRaceLinks(
  env: SupabaseEnv,
  accessToken: string,
  data: {
    subsession_id: number;
    race_number: number;
    iracing_subsession_id?: number | null;
    replay_url?: string | null;
    broadcast_url?: string | null;
    incident_report_url?: string | null;
    photo_album_url?: string | null;
  },
) {
  const badField = invalidRaceLinkField(data);
  if (badField) throw new Error(`race_links.${badField} must be an http(s) URL`);
  const res = await fetch(`${env.url}/rest/v1/race_links?on_conflict=subsession_id,race_number`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, { Prefer: 'return=representation,resolution=merge-duplicates' }),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase upsert error ${res.status} on race_links: ${await res.text()}`);
  const rows = (await res.json()) as RaceLinks[];
  return rows[0];
}
