/**
 * The points calculator's live totals (BR3.1-BR3.3, BR3.10): the loaded points with the reader's edits
 * applied, drop weeks with padding, and the ranking. It reuses the Standings page's own rules from
 * src/lib/seasonTotals.ts (dropsFor, dropWorstRounds, compareStandings), so with no edits the totals,
 * positions and dropped rounds equal the Standings page's. Browser-safe: no server imports.
 */
import { compareStandings, dropWorstRounds, dropsFor } from '../seasonTotals';
import { racePointsAt } from './rulesetPoints';
import type { CalculatorRound, CalculatorSeason, Edit } from './types';

/** One cell's identity, for maps of edits. */
export function editKey(edit: Pick<Edit, 'entrantKey' | 'memberKey' | 'roundIndex'>): string {
  return `${edit.entrantKey}|${edit.memberKey ?? ''}|${edit.roundIndex}`;
}

/**
 * The points an edit gives each race of the round (BR3.10), or null for "did not race". Position mode prices
 * the same position in every race from the round's tables; typed points go into race 1, so a team's top-two
 * re-pick sees them as one race's score.
 */
export function editRacePoints(round: CalculatorRound, edit: Edit): number[] | null {
  if (edit.mode === 'points') {
    return [edit.points, ...Array.from({ length: Math.max(0, round.races - 1) }, () => 0)];
  }
  if (edit.position === null) return null;
  const position = edit.position;
  return round.tables.map((table) => racePointsAt(table, position));
}

/** A driver cell's points after an edit: the races summed, or null for "did not race". */
export function editRoundPoints(round: CalculatorRound, edit: Edit): number | null {
  const races = editRacePoints(round, edit);
  return races === null ? null : races.reduce((sum, p) => sum + p, 0);
}

/**
 * A team's round total from its members' race points: per race, the top two scores of the members who raced it
 * (BR3.1, as topTeamScorers on the Standings page). Null when no member raced the round.
 */
export function teamRoundTotal(
  memberRaces: readonly (readonly (number | null)[] | null)[],
  races: number,
): number | null {
  let any = false;
  let total = 0;
  for (let r = 0; r < races; r++) {
    const scores: number[] = [];
    for (const m of memberRaces) {
      const p = m?.[r];
      if (p === null || p === undefined) continue;
      any = true;
      scores.push(p);
    }
    scores.sort((a, b) => b - a);
    total += scores.slice(0, 2).reduce((sum, p) => sum + p, 0);
  }
  return any ? total : null;
}

export interface EffectivePoints {
  /** Per entrant (season.entrants order), per round: the points after edits, null when not raced. */
  points: (number | null)[][];
  /** Per round: run (completed, or with at least one edited result; BR3.2). Special rounds never run. */
  run: boolean[];
  /** "entrantKey|roundIndex" of every edited cell (for teams, the team's cell). */
  editedCells: Set<string>;
  /** Per team entrant, per member, per round: race points after edits (empty for drivers). */
  memberRaces: ((number | null)[] | null)[][][];
}

/** Applies the edits to the loaded points (use case 5, step 1). Later edits to the same cell win. */
export function applyEdits(season: CalculatorSeason, edits: readonly Edit[]): EffectivePoints {
  const byKey = new Map<string, Edit>();
  for (const edit of edits) {
    const round = season.rounds[edit.roundIndex - 1];
    if (!round || round.state === 'special') continue;
    byKey.set(editKey(edit), edit);
  }
  const run = season.rounds.map((r) => r.state === 'completed');
  const editedCells = new Set<string>();
  for (const edit of byKey.values()) {
    run[edit.roundIndex - 1] = true;
    editedCells.add(`${edit.entrantKey}|${edit.roundIndex}`);
  }

  const points: (number | null)[][] = [];
  const memberRaces: ((number | null)[] | null)[][][] = [];
  for (const entrant of season.entrants) {
    const row = [...entrant.roundPoints];
    if (!season.isTeam) {
      for (const round of season.rounds) {
        const edit = byKey.get(editKey({ entrantKey: entrant.key, roundIndex: round.index }));
        if (edit) row[round.index - 1] = editRoundPoints(round, edit);
      }
      points.push(row);
      memberRaces.push([]);
      continue;
    }
    const members = (entrant.members ?? []).map((m) => m.racePoints.map((r) => (r === null ? null : [...r])));
    for (const round of season.rounds) {
      if (!editedCells.has(`${entrant.key}|${round.index}`)) continue;
      (entrant.members ?? []).forEach((member, mi) => {
        const edit = byKey.get(
          editKey({ entrantKey: entrant.key, memberKey: member.key, roundIndex: round.index }),
        );
        if (edit) members[mi][round.index - 1] = editRacePoints(round, edit);
      });
      row[round.index - 1] = teamRoundTotal(
        members.map((m) => m[round.index - 1]),
        round.races,
      );
    }
    points.push(row);
    memberRaces.push(members);
  }
  return { points, run, editedCells, memberRaces };
}

/** 0-based indexes of the rounds that can ever score (every round but special ones). */
export function scoringRoundIndexes(season: CalculatorSeason): number[] {
  return season.rounds.filter((r) => r.state !== 'special').map((r) => r.index - 1);
}

/**
 * A counted total over a pool of rounds (BR3.2): a round not raced counts 0, the worst `drops` rounds drop
 * once the pool reaches `dropsFromRounds`, at least one round is kept, and `protectedIndex` never drops.
 * Teams never drop. Returns the total and the 0-based indexes of the dropped rounds.
 */
export function countedTotal(
  season: CalculatorSeason,
  points: readonly (number | null)[],
  pool: readonly number[],
  protectedIndex: number | null,
): { total: number; dropped: number[] } {
  const rounds = pool.map((i) => ({ order: season.rounds[i].order, points: points[i] ?? 0 }));
  const drops = season.isTeam ? 0 : dropsFor(pool.length, season.dropCount, season.dropsFromRounds);
  const protectedOrder =
    protectedIndex !== null && pool.includes(protectedIndex) ? season.rounds[protectedIndex].order : null;
  const { total, dropped } = dropWorstRounds(rounds, drops, protectedOrder);
  return { total, dropped: pool.filter((i) => dropped.has(season.rounds[i].order)) };
}

export interface LiveRow {
  /** Index into season.entrants. */
  entrant: number;
  position: number;
  total: number;
  /** 0-based round indexes dropped from the total. */
  dropped: number[];
}

/**
 * The live ranking over the given run rounds (BR3.2, BR3.3): the latest run round is protected unless the
 * ruleset lets the final round drop, as the Standings page protects it mid-season. Ties go to the loaded
 * tiebreak counts, then the name; teams rank on points, then name.
 */
export function liveRanking(
  season: CalculatorSeason,
  points: readonly (readonly (number | null)[])[],
  runIndexes: readonly number[],
): LiveRow[] {
  const latest = runIndexes.length ? Math.max(...runIndexes) : null;
  const protectedIndex = season.canDropFinalRound ? null : latest;
  const rows = season.entrants.map((_, i) => {
    const { total, dropped } = countedTotal(season, points[i], runIndexes, protectedIndex);
    return { entrant: i, total, dropped };
  });
  rows.sort((a, b) => {
    const ea = season.entrants[a.entrant];
    const eb = season.entrants[b.entrant];
    return compareStandings(
      { totalPoints: a.total, ...ea.tiebreak, name: ea.name },
      { totalPoints: b.total, ...eb.tiebreak, name: eb.name },
    );
  });
  return rows.map((r, i) => ({ ...r, position: i + 1 }));
}

/** The 0-based indexes of the run rounds, in calendar order. */
export function runIndexes(effective: EffectivePoints): number[] {
  return effective.run.flatMap((isRun, i) => (isRun ? [i] : []));
}
