/**
 * The points calculator's data (entities.md: CalculatorSeason, CalculatorRound, CalculatorEntrant, Edit,
 * ContentionRow). The server builds a CalculatorSeason once per season and championship and embeds it in the
 * page as JSON; everything after that runs in the browser and is never saved (FR2.8).
 */
import type { RaceTable } from './rulesetPoints';

export const CHAMPIONSHIPS = ['overall', 'alpha', 'gamma', 'delta', 'alpha_team', 'delta_team'] as const;
export type Championship = (typeof CHAMPIONSHIPS)[number];

export const CHAMPIONSHIP_LABELS: Record<Championship, string> = {
  overall: 'Overall',
  alpha: 'Alpha',
  gamma: 'Gamma',
  delta: 'Delta',
  alpha_team: 'Alpha Team',
  delta_team: 'Delta Team',
};

export function isTeamChampionship(championship: Championship): boolean {
  return championship === 'alpha_team' || championship === 'delta_team';
}

export type RoundState = 'completed' | 'future' | 'special';

export interface CalculatorRound {
  /** 1-based calendar position. */
  index: number;
  /** "R3" plus the track when known. */
  label: string;
  /** Short header label, "R3". */
  short: string;
  /**
   * Breaks a points tie between rounds in the drop pool: the higher order drops first, as on the Standings
   * page. A run round's subsession id; a future round sorts after every run round in calendar order.
   */
  order: number;
  state: RoundState;
  format: 'sprint' | 'endurance' | 'special';
  /** 1 to 3. */
  races: number;
  /** Per race: finish and class points tables (empty for a special round). */
  tables: RaceTable[];
  /** BR3.4 (driver) or BR3.5 (team) best case; 0 for a special round. */
  bestCase: number;
  /** BR3.8. */
  secondPlaceCase: number;
  /** A team with one eligible driver uses the one-driver caps (BR3.5). */
  soloBestCase: number;
  soloSecondPlaceCase: number;
  /** The season's last calendar round (BR3.2 projection). */
  isFinal: boolean;
}

/**
 * A team's member driver: per round, per race points (null when they did not race that round; a null race
 * inside a round means they missed that race, which never counts as a 0 in the top-two pick).
 */
export interface CalculatorMember {
  key: string;
  name: string;
  racePoints: ((number | null)[] | null)[];
}

export interface Tiebreak {
  wins: number;
  podiums: number;
  top5s: number;
  top10s: number;
  poles: number;
  lapsLed: number;
  laps: number;
  appearances: number;
}

export interface CalculatorEntrant {
  /** Driver id, the masked key of a hidden driver, or a team id. */
  key: string;
  /** "Hidden Driver" for a hidden driver (BR3.12). */
  name: string;
  /** Per round (index - 1): live points, or null when not raced. */
  roundPoints: (number | null)[];
  tiebreak: Tiebreak;
  /** Teams only. */
  members?: CalculatorMember[];
}

export interface CalculatorSeason {
  seasonId: string;
  seasonName: string;
  championship: Championship;
  championshipLabel: string;
  isTeam: boolean;
  rounds: CalculatorRound[];
  entrants: CalculatorEntrant[];
  /** Ruleset drops.base (2 when missing) plus the season's extra drop weeks; 0 for teams. */
  dropCount: number;
  /** Drops start once this many rounds have run. */
  dropsFromRounds: number;
  canDropFinalRound: boolean;
}

/** One reader change to one cell (BR3.10). A team cell is edited through its member drivers. */
export interface Edit {
  /** The driver's key, or the team's key for a team member's edit. */
  entrantKey: string;
  /** Teams only: the member driver whose result changes; the team total is re-picked (BR3.1). */
  memberKey?: string;
  /** 1-based round index. */
  roundIndex: number;
  mode: 'position' | 'points';
  /** Position mode: 1..N, or null for "did not race". */
  position: number | null;
  /** The points the edit gives the round (position mode: priced from the round's tables). */
  points: number;
}

export type ContentionStatus = 'leader' | 'champion' | 'in_contention' | 'must_win_out' | 'out' | 'final';

export interface ContentionRow {
  key: string;
  name: string;
  position: number;
  /** Live counted total (latest run round protected). */
  countedTotal: number;
  /** Per round: the points shown in the matrix (null = not raced), after edits. */
  roundPoints: (number | null)[];
  /** 1-based indexes of the rounds dropped from the live total. */
  droppedRounds: number[];
  bestCase: number;
  /** The leader's floor (BR3.6); set on the leader's row only. */
  floor: number | null;
  /** Points needed to reach the floor (BR3.6); null for the leader or when no rounds remain. */
  needs: number | null;
  status: ContentionStatus;
  /** For an Out row: the round from which it has been out (BR3.9). */
  outAfterRound: number | null;
}
