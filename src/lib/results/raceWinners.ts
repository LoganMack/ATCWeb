/**
 * Per-race winners for the Race Results list (FR4.2; BR4.1-BR4.6): the Alpha, Gamma and Delta class winners and
 * the Alpha Team and Delta Team winners of every race of the listed rounds, read in one call to the database
 * function race_winners_for_rounds, which applies the raw/final rule, the team top-two rule and name masking.
 */
import { restRpc, type SupabaseEnv } from '../db/client';

export type WinnerSlot = 'alpha' | 'gamma' | 'delta' | 'alpha_team' | 'delta_team';

export const WINNER_SLOTS: readonly WinnerSlot[] = ['alpha', 'gamma', 'delta', 'alpha_team', 'delta_team'];

/** The class name each slot is shown with (its class image for drivers). */
export const SLOT_CLASS_NAME: Record<WinnerSlot, string> = {
  alpha: 'Alpha',
  gamma: 'Gamma',
  delta: 'Delta',
  alpha_team: 'Alpha',
  delta_team: 'Delta',
};

/** The database function refuses more than this many rounds per call. */
export const RACE_WINNERS_MAX_ROUNDS = 200;

/** One row as race_winners_for_rounds returns it. */
export interface RaceWinnerRow {
  subsession_id: number;
  race_number: number;
  slot: WinnerSlot;
  driver_id: string | null;
  driver_name: string | null;
  driver_hidden: boolean | null;
  team_id: string | null;
  team_name: string | null;
  team_logo_url: string | null;
}

export type RaceWinner =
  | { slot: 'alpha' | 'gamma' | 'delta'; kind: 'driver'; driverId: string; name: string; hidden: boolean }
  | { slot: 'alpha_team' | 'delta_team'; kind: 'team'; teamId: string; name: string; logoUrl: string | null };

export interface RaceWinners {
  raceNumber: number;
  winners: RaceWinner[];
}

function toWinner(row: RaceWinnerRow): RaceWinner | null {
  if (row.slot === 'alpha_team' || row.slot === 'delta_team') {
    if (!row.team_id) return null;
    return {
      slot: row.slot,
      kind: 'team',
      teamId: row.team_id,
      name: row.team_name ?? 'Unknown team',
      logoUrl: row.team_logo_url,
    };
  }
  if (!WINNER_SLOTS.includes(row.slot) || !row.driver_id) return null;
  return {
    slot: row.slot,
    kind: 'driver',
    driverId: row.driver_id,
    name: row.driver_name ?? 'Unknown driver',
    hidden: row.driver_hidden === true,
  };
}

/** Groups rows by round, then race (ascending), each race's winners in slot order. */
export function groupRaceWinners(rows: RaceWinnerRow[]): Map<number, RaceWinners[]> {
  const byRound = new Map<number, Map<number, RaceWinner[]>>();
  for (const row of rows) {
    const winner = toWinner(row);
    if (!winner) continue;
    const roundId = Number(row.subsession_id);
    if (!byRound.has(roundId)) byRound.set(roundId, new Map());
    const races = byRound.get(roundId)!;
    if (!races.has(row.race_number)) races.set(row.race_number, []);
    races.get(row.race_number)!.push(winner);
  }
  const out = new Map<number, RaceWinners[]>();
  for (const [roundId, races] of byRound) {
    out.set(
      roundId,
      [...races.entries()]
        .sort(([a], [b]) => a - b)
        .map(([raceNumber, winners]) => ({
          raceNumber,
          winners: winners.sort((a, b) => WINNER_SLOTS.indexOf(a.slot) - WINNER_SLOTS.indexOf(b.slot)),
        })),
    );
  }
  return out;
}

/**
 * Winners of every race of these rounds, keyed by subsession id. One database call; ids beyond the function's
 * 200-round limit are left out (a season has far fewer). Never throws: on failure the error is logged and the
 * map is empty, so the list still renders without winners.
 */
export async function getRaceWinnersForRounds(
  env: SupabaseEnv,
  subsessionIds: number[],
): Promise<Map<number, RaceWinners[]>> {
  const ids = [...new Set(subsessionIds.filter((id) => Number.isSafeInteger(id)))];
  if (ids.length === 0) return new Map();
  if (ids.length > RACE_WINNERS_MAX_ROUNDS) {
    console.error(`Race winners: ${ids.length} rounds listed, reading the first ${RACE_WINNERS_MAX_ROUNDS}`);
  }
  try {
    const rows = await restRpc<RaceWinnerRow[]>(env, 'race_winners_for_rounds', {
      p_subsession_ids: ids.slice(0, RACE_WINNERS_MAX_ROUNDS),
    });
    return groupRaceWinners(rows ?? []);
  } catch (err) {
    console.error('Failed to load race winners:', err);
    return new Map();
  }
}
