/**
 * The points calculator's browser state and view models (FR2-FR4, BR3.1-BR3.10): the reader's edit set, the
 * recompute after every change, the Scenario Editor's draft (edited apart from the bars until Save), and plain
 * data for each part the page draws (bars with their per-race segments, the results matrix, the cell editors).
 * No DOM here, so the tests check every rule without a browser; src/scripts/pointsCalculatorView.ts turns
 * these into elements.
 */
import { applyEdits, editKey, editRacePoints, runIndexes, teamRoundTotal } from '../lib/calculator/engine';
import { computeContention } from '../lib/calculator/contention';
import { roundPointsAt } from '../lib/calculator/rulesetPoints';
import type {
  CalculatorEntrant,
  CalculatorRound,
  CalculatorSeason,
  ContentionRow,
  Edit,
} from '../lib/calculator/types';

export interface CalcState {
  season: CalculatorSeason;
  /** By editKey; the URL never carries these (FR2.8). */
  edits: Map<string, Edit>;
}

/** The embedded season, or null when the fragment holds none or it is malformed. */
export function parseCalculatorSeason(text: string | null | undefined): CalculatorSeason | null {
  if (!text) return null;
  try {
    const data = JSON.parse(text) as CalculatorSeason;
    if (!Array.isArray(data.rounds) || !Array.isArray(data.entrants)) return null;
    return data;
  } catch {
    return null;
  }
}

export function createState(season: CalculatorSeason): CalcState {
  return { season, edits: new Map() };
}

export function editList(state: CalcState): Edit[] {
  return [...state.edits.values()];
}

export function setEdit(state: CalcState, edit: Edit): void {
  state.edits.set(editKey(edit), edit);
}

/** Undo cell (or Undo driver for a team member's line). */
export function undoEdit(
  state: CalcState,
  cell: Pick<Edit, 'entrantKey' | 'memberKey' | 'roundIndex'>,
): void {
  state.edits.delete(editKey(cell));
}

/** Every edit of one cell: the driver's own, or each member's for a team. */
export function cellEdits(state: CalcState, entrantKey: string, roundIndex: number): Edit[] {
  return editList(state).filter((e) => e.entrantKey === entrantKey && e.roundIndex === roundIndex);
}

/** Reset (FR2.8): every edit goes. */
export function resetEdits(state: CalcState): void {
  state.edits.clear();
}

// --- The Scenario Editor's draft ------------------------------------------------------------------------------

/**
 * The editor works on a copy of the edits, so the bars change only on Save and closing without Save loses that
 * session's changes.
 */
export function draftState(state: CalcState): CalcState {
  return { season: state.season, edits: new Map(state.edits) };
}

/** Save: the draft's edits become the page's. */
export function saveDraft(state: CalcState, draft: CalcState): void {
  state.edits = new Map(draft.edits);
}

// --- Recompute (use case 5) -------------------------------------------------------------------------------

export interface Snapshot {
  rows: ContentionRow[];
  /** "entrantKey|roundIndex" of every edited cell. */
  editedCells: Set<string>;
  /** Per round (0-based): run, after edits. */
  run: boolean[];
  /** Per entrant key: per round, per member race points after edits (teams only). */
  memberRaces: Map<string, ((number | null)[] | null)[][]>;
  /** No round has a result yet (FR8.1): everyone is shown Contending. */
  nothingRun: boolean;
}

export function recompute(state: CalcState): Snapshot {
  const edits = editList(state);
  const effective = applyEdits(state.season, edits);
  const rows = computeContention(state.season, edits);
  const memberRaces = new Map<string, ((number | null)[] | null)[][]>();
  state.season.entrants.forEach((e, i) => memberRaces.set(e.key, effective.memberRaces[i]));
  return {
    rows,
    editedCells: effective.editedCells,
    run: effective.run,
    memberRaces,
    nothingRun: runIndexes(effective).length === 0,
  };
}

// --- Points Contenders bars (FR4.1, FR4.2) ----------------------------------------------------------------

export type ChipTone = 'gold' | 'blue' | 'pink' | 'muted';

/** One race (or a whole round with no race breakdown) of the current total. */
export interface BarSegment {
  /** "R3 · Spa · Race 2", or the round's label for a one-race or whole round. */
  label: string;
  points: number;
  /** Percent of the shared scale. */
  pct: number;
}

export interface BarView {
  key: string;
  position: number;
  name: string;
  /** Percent of the shared scale. */
  countedPct: number;
  bestPct: number;
  /** The current total's races, in calendar order; dropped rounds are not part of it. */
  segments: BarSegment[];
  /** "120 → 168", or the final total once the season is over. */
  numbers: string;
  /** "+48" for a chaser, "R6" for the round an eliminated row went out, else empty. */
  needs: string;
  chip: { label: string; tone: ChipTone };
  /** The row's text equivalent: every value the bar, the segments and the right column show. */
  ariaLabel: string;
}

export interface FloorView {
  /** The leader's floor, or null when no rounds remain. */
  floor: number | null;
  floorPct: number | null;
}

/** The status as the row's sentence says it ("eliminated after round 7", "final position 3"). */
function spokenStatus(row: ContentionRow, chipLabel: string): string {
  if (row.status === 'final') return `final position ${row.position}`;
  if (row.status === 'out' && row.outAfterRound !== null)
    return `eliminated after round ${row.outAfterRound}`;
  return chipLabel.toLowerCase();
}

export function chipFor(row: ContentionRow, nothingRun: boolean): { label: string; tone: ChipTone } {
  if (nothingRun && (row.status === 'leader' || row.status === 'must_win_out')) {
    return { label: 'Contending', tone: 'blue' };
  }
  switch (row.status) {
    case 'leader':
      return { label: 'Leader', tone: 'gold' };
    case 'champion':
      return { label: 'Champion', tone: 'gold' };
    case 'in_contention':
      return { label: 'Contending', tone: 'blue' };
    case 'must_win_out':
      return { label: 'Must Win Out', tone: 'pink' };
    case 'out':
      return { label: 'Eliminated', tone: 'muted' };
    case 'final':
      return { label: `P${row.position}`, tone: 'muted' };
  }
}

export function contendersFloor(state: CalcState, snapshot: Snapshot): FloorView {
  const remaining = state.season.rounds.some((r, i) => r.state !== 'special' && !snapshot.run[i]);
  const leader = snapshot.rows.find((r) => r.floor !== null);
  const floor = remaining ? (leader?.floor ?? null) : null;
  return { floor, floorPct: floor === null ? null : pct(floor, barScale(snapshot.rows)) };
}

function barScale(rows: readonly ContentionRow[]): number {
  return Math.max(1, ...rows.map((r) => Math.max(r.bestCase, r.countedTotal)));
}

function pct(value: number, scale: number): number {
  return Math.max(0, Math.min(100, (value / scale) * 100));
}

/** One team race: the top two members' points, as the team's round total counts them (BR3.1). */
function teamRacePoints(members: readonly ((number | null)[] | null)[], race: number): number | null {
  const scores = members.map((m) => m?.[race]).filter((p): p is number => p !== null && p !== undefined);
  if (scores.length === 0) return null;
  return scores
    .sort((a, b) => b - a)
    .slice(0, 2)
    .reduce((s, p) => s + p, 0);
}

/**
 * Each race's points of one round after the edits, or null when the round can only be shown whole: a driver's
 * edited round in position mode is priced per race; typed points and rounds with no breakdown are whole.
 */
function racesOfRound(
  state: CalcState,
  snapshot: Snapshot,
  entrant: CalculatorEntrant,
  round: CalculatorRound,
): (number | null)[] | null {
  const i = round.index - 1;
  if (state.season.isTeam) {
    const members = (snapshot.memberRaces.get(entrant.key) ?? []).map((m) => m[i] ?? null);
    return Array.from({ length: round.races }, (_, r) => teamRacePoints(members, r));
  }
  const edit = state.edits.get(editKey({ entrantKey: entrant.key, roundIndex: round.index }));
  if (edit) return edit.mode === 'position' ? editRacePoints(round, edit) : null;
  return entrant.racePoints?.[i] ?? null;
}

/** The current total's segments: every counted round's races with points, in calendar order. */
export function barSegments(state: CalcState, snapshot: Snapshot, row: ContentionRow): BarSegment[] {
  const scale = barScale(snapshot.rows);
  const entrant = state.season.entrants.find((e) => e.key === row.key);
  if (!entrant) return [];
  const out: BarSegment[] = [];
  for (const round of state.season.rounds) {
    const i = round.index - 1;
    const points = row.roundPoints[i];
    if (!snapshot.run[i] || round.state === 'special' || row.droppedRounds.includes(round.index)) continue;
    if (points === null || points === undefined || points <= 0) continue;
    const races = racesOfRound(state, snapshot, entrant, round);
    const sum = races?.reduce<number>((s, p) => s + (p ?? 0), 0);
    if (races && round.races > 1 && sum !== undefined && Math.abs(sum - points) < 0.001) {
      races.forEach((p, r) => {
        if (p !== null && p > 0)
          out.push({ label: `${round.label} · Race ${r + 1}`, points: p, pct: pct(p, scale) });
      });
    } else {
      out.push({ label: round.label, points, pct: pct(points, scale) });
    }
  }
  return out;
}

export function barViews(state: CalcState, snapshot: Snapshot): BarView[] {
  const scale = barScale(snapshot.rows);
  return snapshot.rows.map((row) => {
    const done = row.status === 'champion' || row.status === 'final';
    const chip = chipFor(row, snapshot.nothingRun);
    const segments = barSegments(state, snapshot, row);
    const needs =
      row.status === 'out'
        ? row.outAfterRound !== null
          ? `R${row.outAfterRound}`
          : ''
        : row.needs !== null && row.needs > 0
          ? `+${row.needs}`
          : '';
    const sentence = [
      row.name,
      spokenStatus(row, chip.label),
      `${row.countedTotal} points`,
      done ? null : `best possible ${row.bestCase}`,
      row.needs !== null && row.needs > 0 ? `needs ${row.needs} more` : null,
      segments.length ? `counted: ${segments.map((s) => `${s.label}, ${s.points}`).join('; ')}` : null,
    ].filter(Boolean);
    return {
      key: row.key,
      position: row.position,
      name: row.name,
      countedPct: pct(row.countedTotal, scale),
      bestPct: pct(done ? row.countedTotal : row.bestCase, scale),
      segments,
      numbers: done ? `${row.countedTotal}` : `${row.countedTotal} → ${row.bestCase}`,
      needs,
      chip,
      ariaLabel: sentence.join(', '),
    };
  });
}

// --- Results matrix (FR2.5-FR2.9, FR4.3) ------------------------------------------------------------------

export type CellState = 'counted' | 'dropped' | 'future' | 'special' | 'empty';

export interface MatrixCell {
  roundIndex: number;
  text: string;
  state: CellState;
  edited: boolean;
  disabled: boolean;
  title: string | null;
  ariaLabel: string;
}

export interface MatrixRow {
  key: string;
  position: number;
  name: string;
  total: number;
  status: { label: string; tone: ChipTone };
  cells: MatrixCell[];
}

export function matrixRows(state: CalcState, snapshot: Snapshot): MatrixRow[] {
  const rounds = state.season.rounds;
  return snapshot.rows.map((row) => {
    const cells = rounds.map((round, i): MatrixCell => {
      const value = row.roundPoints[i];
      const edited = snapshot.editedCells.has(`${row.key}|${round.index}`);
      if (round.state === 'special') {
        return {
          roundIndex: round.index,
          text: '—',
          state: 'special',
          edited: false,
          disabled: true,
          title: 'No points table for this format',
          ariaLabel: `${row.name}, round ${round.index}: no points table for this format`,
        };
      }
      const dropped = row.droppedRounds.includes(round.index);
      const run = snapshot.run[i];
      let state: CellState;
      let text: string;
      let spoken: string;
      if (value === null || value === undefined) {
        state = run ? 'empty' : 'future';
        text = run ? '–' : '+';
        spoken = run ? 'did not race' : 'no result yet';
      } else {
        state = dropped ? 'dropped' : 'counted';
        text = String(value);
        spoken = `${value} points${dropped ? ', dropped' : ''}`;
      }
      return {
        roundIndex: round.index,
        text,
        state,
        edited,
        disabled: false,
        title: null,
        ariaLabel: `${row.name}, round ${round.index}: ${spoken}${edited ? ', edited' : ''}`,
      };
    });
    return {
      key: row.key,
      position: row.position,
      name: row.name,
      total: row.countedTotal,
      status: chipFor(row, snapshot.nothingRun),
      cells,
    };
  });
}

// --- Cell editors (FR2.5, FR2.9, BR3.10) ------------------------------------------------------------------

export interface PositionOption {
  /** "p3", or "dns" for did not race. */
  value: string;
  label: string;
  points: number;
}

/** P1..Pn with that round's points, then "Did not race (0)". */
export function positionOptions(round: CalculatorRound, fieldSize: number): PositionOption[] {
  const out: PositionOption[] = [];
  for (let p = 1; p <= Math.max(1, fieldSize); p++) {
    const points = roundPointsAt(round.tables, p);
    out.push({ value: `p${p}`, label: `P${p} (${points} ${points === 1 ? 'pt' : 'pts'})`, points });
  }
  out.push({ value: 'dns', label: 'Did not race (0)', points: 0 });
  return out;
}

/** BR3.10: typed points must be a whole number from 0 to 999; anything else is null (Apply disabled). */
export function parseTypedPoints(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  return Number(trimmed);
}

export const TYPED_POINTS_HINT = 'Whole number, 0 or more';

/** What one editor line holds before Apply. */
export interface Draft {
  typed: boolean;
  /** Select value ("p3" or "dns"), used when not typed. */
  choice: string;
  /** Raw typed text, used when typed. */
  text: string;
}

/** The edit a draft makes, or null while it is invalid. */
export function draftEdit(
  round: CalculatorRound,
  draft: Draft,
  cell: { entrantKey: string; memberKey?: string },
): Edit | null {
  const base = { entrantKey: cell.entrantKey, memberKey: cell.memberKey, roundIndex: round.index };
  if (draft.typed) {
    const points = parseTypedPoints(draft.text);
    return points === null ? null : { ...base, mode: 'points', position: null, points };
  }
  if (draft.choice === 'dns') return { ...base, mode: 'position', position: null, points: 0 };
  const position = Number(draft.choice.slice(1));
  if (!Number.isInteger(position) || position < 1) return null;
  return { ...base, mode: 'position', position, points: roundPointsAt(round.tables, position) };
}

/** The editor's starting draft: the cell's edit if it has one, else the option matching its points. */
export function initialDraft(
  round: CalculatorRound,
  value: number | null,
  edit: Edit | undefined,
  fieldSize: number,
): Draft {
  if (edit) {
    if (edit.mode === 'points') return { typed: true, choice: 'p1', text: String(edit.points) };
    return { typed: false, choice: edit.position === null ? 'dns' : `p${edit.position}`, text: '' };
  }
  if (value === null) return { typed: false, choice: 'dns', text: '' };
  const match = positionOptions(round, fieldSize).find((o) => o.value !== 'dns' && o.points === value);
  return match
    ? { typed: false, choice: match.value, text: '' }
    : { typed: true, choice: 'p1', text: String(value) };
}

/** Positions offered to one driver: the championship's field size. */
export function driverFieldSize(season: CalculatorSeason): number {
  return season.entrants.length;
}

/** Positions offered to a team member: the round's finish table, at least three places. */
export function memberFieldSize(round: CalculatorRound): number {
  return Math.max(3, round.tables[0]?.finish.length ?? 0);
}

export interface TeamLine {
  memberKey: string;
  name: string;
  /** Per race points after the draft (null = did not race that race). */
  races: (number | null)[] | null;
  counts: boolean;
  edited: boolean;
}

/**
 * TeamCellEditor (FR2.9): each member's race points with the drafts applied, which two count per race and the
 * team's round total, re-picked live as the drafts change. A draft that is invalid keeps the line's last value.
 */
export function teamLines(
  state: CalcState,
  snapshot: Snapshot,
  entrant: CalculatorEntrant,
  round: CalculatorRound,
  drafts: ReadonlyMap<string, Draft>,
): { lines: TeamLine[]; total: number | null; valid: boolean } {
  const members = entrant.members ?? [];
  const current = snapshot.memberRaces.get(entrant.key) ?? [];
  let valid = true;
  const races = members.map((m, mi) => {
    const draft = drafts.get(m.key);
    if (!draft) return current[mi]?.[round.index - 1] ?? null;
    const edit = draftEdit(round, draft, { entrantKey: entrant.key, memberKey: m.key });
    if (!edit) {
      valid = false;
      return current[mi]?.[round.index - 1] ?? null;
    }
    return editRacePoints(round, edit);
  });
  const counting = new Set<number>();
  for (let r = 0; r < round.races; r++) {
    races
      .map((rs, mi) => ({ mi, p: rs?.[r] }))
      .filter((x): x is { mi: number; p: number } => x.p !== null && x.p !== undefined)
      .sort((a, b) => b.p - a.p)
      .slice(0, 2)
      .forEach((x) => counting.add(x.mi));
  }
  const lines = members.map((m, mi) => ({
    memberKey: m.key,
    name: m.name,
    races: races[mi],
    counts: counting.has(mi),
    edited: state.edits.has(editKey({ entrantKey: entrant.key, memberKey: m.key, roundIndex: round.index })),
  }));
  return { lines, total: teamRoundTotal(races, round.races), valid };
}
