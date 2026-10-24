/**
 * Round penalties (0104): whole-round penalties, mostly the next-round bans from the PP Penalties table
 * (ppPenaltyTable.ts) and the 1-round ban for the season PP limit. Owed until a steward marks one served.
 * Record-keeping only, never applied to results.
 */

import { restGet, restPost, restPatch, restDelete, type SupabaseEnv } from './db/client';
import { NEXT_ROUND_LABELS } from './ppPenaltyTable';

export type RoundPenaltyKind = 'qualifying_ban' | 'pit_lane_start' | 'race_ban' | 'round_ban' | 'other';

export const ROUND_PENALTY_KINDS: RoundPenaltyKind[] = [
  'qualifying_ban',
  'pit_lane_start',
  'race_ban',
  'round_ban',
  'other',
];

export const ROUND_PENALTY_LABELS: Record<RoundPenaltyKind, string> = {
  ...NEXT_ROUND_LABELS,
  round_ban: '1-round ban',
  other: 'Other',
};

export const ROUND_PENALTY_NOTE_MAX_LENGTH = 500;

export interface RoundPenalty {
  id: string;
  subsession_id: number;
  driver_id: string;
  kind: RoundPenaltyKind;
  note: string | null;
  served_subsession_id: number | null;
  created_at: string;
}

export interface RoundRef {
  subsession_id: number;
  track_name: string;
  start_time: string;
}

const SELECT = 'id,subsession_id,driver_id,kind,note,served_subsession_id,created_at';
// Reads use the masked view (U4): hidden drivers' full names masked in the note, posted rounds for non-admins.
const READ_PATH = 'round_penalties_shown';

/** "Qualifying ban" or, for Other, its note. */
export function roundPenaltyLabel(p: { kind: RoundPenaltyKind; note: string | null }): string {
  return p.kind === 'other' ? (p.note ?? 'Other') : ROUND_PENALTY_LABELS[p.kind];
}

export function isRoundPenaltyKind(v: string): v is RoundPenaltyKind {
  return (ROUND_PENALTY_KINDS as string[]).includes(v);
}

export interface RoundPenaltyData {
  /** Penalties earned in this round. */
  earnedHere: RoundPenalty[];
  /** Penalties from earlier rounds that are still owed, or were served at this one. */
  carriedIn: RoundPenalty[];
  /** subsession_id -> round, for every round the above refer to (earned or served at). */
  roundById: Map<number, RoundRef>;
  /** False when the table couldn't be read (e.g. migration 0104 not applied yet) — callers hide the feature rather than show it empty. */
  available: boolean;
}

/**
 * Everything the Incident Report needs about round penalties for one round.
 * Never throws: on a failed read it returns `available: false`.
 */
export async function getRoundPenaltyData(env: SupabaseEnv, round: RoundRef): Promise<RoundPenaltyData> {
  try {
    const [earnedHere, owedOrServedHere] = await Promise.all([
      restGet<RoundPenalty[]>(
        env,
        `${READ_PATH}?select=${SELECT}&subsession_id=eq.${round.subsession_id}&order=created_at.asc`,
      ),
      restGet<RoundPenalty[]>(
        env,
        `${READ_PATH}?select=${SELECT}&subsession_id=neq.${round.subsession_id}` +
          `&or=(served_subsession_id.is.null,served_subsession_id.eq.${round.subsession_id})&order=created_at.asc`,
      ),
    ]);

    const ids = new Set<number>();
    for (const p of [...earnedHere, ...owedOrServedHere]) {
      ids.add(p.subsession_id);
      if (p.served_subsession_id !== null) ids.add(p.served_subsession_id);
    }
    ids.delete(round.subsession_id);
    const rounds =
      ids.size === 0
        ? []
        : await restGet<RoundRef[]>(
            env,
            `curated_rounds?select=subsession_id,track_name,start_time&subsession_id=in.(${[...ids].join(',')})`,
          );
    const roundById = new Map<number, RoundRef>([
      [round.subsession_id, round],
      ...rounds.map((r) => [r.subsession_id, r] as const),
    ]);

    // Only rounds before this one can carry a penalty into it. One whose round
    // can't be looked up any more (hidden or removed) is kept rather than
    // dropped — otherwise it would never be shown anywhere to be served.
    const thisStart = new Date(round.start_time).getTime();
    const carriedIn = owedOrServedHere.filter((p) => {
      const earned = roundById.get(p.subsession_id);
      return earned === undefined || new Date(earned.start_time).getTime() < thisStart;
    });

    return { earnedHere, carriedIn, roundById, available: true };
  } catch (err) {
    console.error('Failed to load round penalties:', err);
    return { earnedHere: [], carriedIn: [], roundById: new Map(), available: false };
  }
}

/** One driver's round penalties earned in one round, oldest first. */
export async function getRoundPenaltiesForDriver(
  env: SupabaseEnv,
  subsessionId: number,
  driverId: string,
): Promise<RoundPenalty[]> {
  return restGet<RoundPenalty[]>(
    env,
    `${READ_PATH}?select=${SELECT}&subsession_id=eq.${subsessionId}&driver_id=eq.${encodeURIComponent(driverId)}&order=created_at.asc`,
  );
}

const byId = (id: string) => `round_penalties?id=eq.${encodeURIComponent(id)}`;

/** Admin: log a round penalty against a driver for the round it was earned in. */
export async function createRoundPenalty(
  env: SupabaseEnv,
  accessToken: string,
  input: {
    subsession_id: number;
    driver_id: string;
    kind: RoundPenaltyKind;
    note: string | null;
    created_by: string;
  },
): Promise<void> {
  await restPost(env, accessToken, 'round_penalties', input);
}

/** Admin: edit a round penalty. `markOwed` clears where it was served; otherwise that's left as it is. */
export async function updateRoundPenalty(
  env: SupabaseEnv,
  accessToken: string,
  id: string,
  input: { driver_id: string; kind: RoundPenaltyKind; note: string | null; markOwed: boolean },
): Promise<void> {
  await restPatch(env, accessToken, byId(id), {
    driver_id: input.driver_id,
    kind: input.kind,
    note: input.note,
    ...(input.markOwed ? { served_subsession_id: null } : {}),
    updated_at: new Date().toISOString(),
  });
}

/** Admin: mark a round penalty served at a round, or owed again (null). */
export async function setRoundPenaltyServed(
  env: SupabaseEnv,
  accessToken: string,
  id: string,
  servedSubsessionId: number | null,
): Promise<void> {
  await restPatch(env, accessToken, byId(id), {
    served_subsession_id: servedSubsessionId,
    updated_at: new Date().toISOString(),
  });
}

export async function deleteRoundPenalty(env: SupabaseEnv, accessToken: string, id: string): Promise<void> {
  await restDelete(env, accessToken, byId(id));
}
