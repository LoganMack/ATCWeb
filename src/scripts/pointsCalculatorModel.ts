/**
 * The points calculator's browser state and view models (FR2-FR5, BR3.1-BR3.10): one edit set shared by Points
 * Contenders and Points Scenarios, the recompute after every change, and plain data for each part the page
 * draws (bars, the results matrix, the cell editors, the Scenarios pickers and verdict). No DOM here, so the
 * tests check every rule without a browser; src/scripts/pointsCalculatorView.ts turns these into elements.
 */
import { applyEdits, editKey, editRacePoints, runIndexes, teamRoundTotal } from '../lib/calculator/engine';
import { chaseNeeds, computeContention, liveTotals } from '../lib/calculator/contention';
import { roundPointsAt } from '../lib/calculator/rulesetPoints';
import type {
  CalculatorEntrant,
  CalculatorRound,
  CalculatorSeason,
  ContentionRow,
  Edit,
} from '../lib/calculator/types';

export type CalculatorView = 'contenders' | 'scenarios';

export interface CalcState {
  season: CalculatorSeason;
  /** By editKey; the URL never carries these (FR2.8). */
  edits: Map<string, Edit>;
  view: CalculatorView;
  chaser: string | null;
  target: string | null;
  matrixOpen: boolean;
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

export function createState(season: CalculatorSeason, view: CalculatorView): CalcState {
  const state: CalcState = { season, edits: new Map(), view, chaser: null, target: null, matrixOpen: false };
  const rows = computeContention(season, []);
  // Use case 4: Chaser defaults to P2 and Target to P1.
  state.target = rows[0]?.key ?? null;
  state.chaser = rows[1]?.key ?? null;
  return state;
}

export function editList(state: CalcState): Edit[] {
  return [...state.edits.values()];
}

export function setEdit(state: CalcState, edit: Edit): void {
  state.edits.set(editKey(edit), edit);
}

/** Undo cell (or Undo driver for a team member's line). */
export function undoEdit(state: CalcState, cell: Pick<Edit, 'entrantKey' | 'memberKey' | 'roundIndex'>): void {
  state.edits.delete(editKey(cell));
}

/** Every edit of one cell: the driver's own, or each member's for a team. */
export function cellEdits(state: CalcState, entrantKey: string, roundIndex: number): Edit[] {
  return editList(state).filter((e) => e.entrantKey === entrantKey && e.roundIndex === roundIndex);
}

/** Reset (FR2.8): every edit in both views goes. */
export function resetEdits(state: CalcState): void {
  state.edits.clear();
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
  /** No round has a result yet (FR8.1): everyone is shown In contention. */
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

export interface BarView {
  key: string;
  position: number;
  name: string;
  /** Percent of the shared scale. */
  countedPct: number;
  bestPct: number;
  numbers: string;
  chip: { label: string; tone: ChipTone };
  ariaLabel: string;
}

export interface ContendersHeader {
  roundsLeft: number;
  maxRoundPoints: number;
  drops: number;
  /** The leader's floor, or null when no rounds remain. */
  floor: number | null;
  floorPct: number | null;
  text: string;
}

/** The status as the bar's sentence says it ("out after round 7", "final position 3"). */
function spokenStatus(row: ContentionRow, chipLabel: string): string {
  if (row.status === 'final') return `final position ${row.position}`;
  if (row.status === 'out' && row.outAfterRound !== null) return `out after round ${row.outAfterRound}`;
  return chipLabel.toLowerCase();
}

function chipFor(row: ContentionRow, nothingRun: boolean): { label: string; tone: ChipTone } {
  if (nothingRun && (row.status === 'leader' || row.status === 'must_win_out')) {
    return { label: 'In contention', tone: 'blue' };
  }
  switch (row.status) {
    case 'leader':
      return { label: 'Leader', tone: 'gold' };
    case 'champion':
      return { label: 'Champion', tone: 'gold' };
    case 'in_contention':
      return { label: 'In contention', tone: 'blue' };
    case 'must_win_out':
      return { label: 'Must win out', tone: 'pink' };
    case 'out':
      return { label: row.outAfterRound !== null ? `Out · R${row.outAfterRound}` : 'Out', tone: 'muted' };
    case 'final':
      return { label: `P${row.position}`, tone: 'muted' };
  }
}

export function contendersHeader(state: CalcState, snapshot: Snapshot): ContendersHeader {
  const remaining = state.season.rounds.filter((r, i) => r.state !== 'special' && !snapshot.run[i]);
  const maxRoundPoints = remaining.reduce((m, r) => Math.max(m, r.bestCase), 0);
  const leader = snapshot.rows.find((r) => r.floor !== null);
  const floor = remaining.length ? (leader?.floor ?? null) : null;
  const scale = barScale(snapshot.rows);
  const drops = state.season.dropCount;
  const parts = [
    remaining.length === 0
      ? 'No rounds left'
      : `${remaining.length} ${remaining.length === 1 ? 'round' : 'rounds'} left`,
  ];
  if (remaining.length) parts.push(`up to ${maxRoundPoints} points a round`);
  parts.push(drops > 0 ? `drops: worst ${drops} ${drops === 1 ? 'round' : 'rounds'}` : 'no drops');
  return {
    roundsLeft: remaining.length,
    maxRoundPoints,
    drops,
    floor,
    floorPct: floor === null ? null : pct(floor, scale),
    text: parts.join(' · '),
  };
}

function barScale(rows: readonly ContentionRow[]): number {
  return Math.max(1, ...rows.map((r) => Math.max(r.bestCase, r.countedTotal)));
}

function pct(value: number, scale: number): number {
  return Math.max(0, Math.min(100, (value / scale) * 100));
}

export function barViews(snapshot: Snapshot): BarView[] {
  const scale = barScale(snapshot.rows);
  return snapshot.rows.map((row) => {
    const done = row.status === 'champion' || row.status === 'final';
    const needs = row.needs !== null && row.needs > 0 ? ` · needs +${row.needs}` : '';
    const numbers = done ? `${row.countedTotal}` : `${row.countedTotal} → ${row.bestCase}${needs}`;
    const chip = chipFor(row, snapshot.nothingRun);
    const sentence = [
      row.name,
      `${row.countedTotal} points`,
      done ? null : `best case ${row.bestCase}`,
      row.needs !== null && row.needs > 0 ? `needs ${row.needs}` : null,
      spokenStatus(row, chip.label),
    ].filter(Boolean);
    return {
      key: row.key,
      position: row.position,
      name: row.name,
      countedPct: pct(row.countedTotal, scale),
      bestPct: pct(done ? row.countedTotal : row.bestCase, scale),
      numbers,
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
export function initialDraft(round: CalculatorRound, value: number | null, edit: Edit | undefined, fieldSize: number): Draft {
  if (edit) {
    if (edit.mode === 'points') return { typed: true, choice: 'p1', text: String(edit.points) };
    return { typed: false, choice: edit.position === null ? 'dns' : `p${edit.position}`, text: '' };
  }
  if (value === null) return { typed: false, choice: 'dns', text: '' };
  const match = positionOptions(round, fieldSize).find((o) => o.value !== 'dns' && o.points === value);
  return match ? { typed: false, choice: match.value, text: '' } : { typed: true, choice: 'p1', text: String(value) };
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

// --- Points Scenarios (FR5) -------------------------------------------------------------------------------

/** Choosing the same entrant as both Chaser and Target swaps the two. */
export function pick(state: CalcState, which: 'chaser' | 'target', key: string): void {
  const other = which === 'chaser' ? 'target' : 'chaser';
  if (state[other] === key) state[other] = state[which];
  state[which] = key;
}

/** The rounds the head-to-head table lists: every round still to run on the loaded calendar. */
export function scenarioRounds(season: CalculatorSeason): CalculatorRound[] {
  return season.rounds.filter((r) => r.state !== 'completed');
}

export interface HeadToHeadRow {
  key: string;
  name: string;
  now: number;
  final: number;
}

export interface ScenarioModel {
  single: boolean;
  options: { key: string; label: string }[];
  chaser: HeadToHeadRow | null;
  target: HeadToHeadRow | null;
  verdict: string;
}

const isFutureEdit = (season: CalculatorSeason, e: Edit) => season.rounds[e.roundIndex - 1]?.state === 'future';

export function scenarioModel(state: CalcState, snapshot: Snapshot): ScenarioModel {
  const { season } = state;
  const options = snapshot.rows.map((r) => ({ key: r.key, label: `${r.position}. ${r.name}` }));
  if (season.entrants.length < 2) {
    return {
      single: true,
      options,
      chaser: null,
      target: null,
      verdict: 'Only one entrant in this championship, so there is no one to compare.',
    };
  }
  const edits = editList(state);
  const now = liveTotals(season, edits.filter((e) => !isFutureEdit(season, e)));
  const final = liveTotals(season, edits);
  const row = (key: string | null): HeadToHeadRow | null => {
    const entrant = season.entrants.find((e) => e.key === key);
    if (!entrant) return null;
    return { key: entrant.key, name: entrant.name, now: now.get(entrant.key) ?? 0, final: final.get(entrant.key) ?? 0 };
  };
  const chaser = row(state.chaser);
  const target = row(state.target);
  return { single: false, options, chaser, target, verdict: chaser && target ? verdict(state, snapshot, chaser, target) : '' };
}

function verdict(state: CalcState, snapshot: Snapshot, chaser: HeadToHeadRow, target: HeadToHeadRow): string {
  const { season } = state;
  const open = scenarioRounds(season).filter((r) => r.state !== 'special');
  const set = (key: string) => open.every((r) => snapshot.editedCells.has(`${key}|${r.index}`));
  if (open.length === 0 || (set(chaser.key) && set(target.key))) {
    const positions = new Map(snapshot.rows.map((r) => [r.key, r.position]));
    const chaserAhead = (positions.get(chaser.key) ?? 0) < (positions.get(target.key) ?? 0);
    const gap = Math.abs(chaser.final - target.final);
    return chaserAhead
      ? `${chaser.name} finishes ahead of ${target.name} by ${gap} (${chaser.final} to ${target.final}).`
      : `${target.name} stays ahead by ${gap} (${target.final} to ${chaser.final}).`;
  }
  const chase = chaseNeeds(season, editList(state), chaser.key, target.key);
  if (!chase) return '';
  if (chase.needs === null) {
    return `${chaser.name} can no longer reach ${target.name}: best case ${chase.best}, ${target.name}’s floor ${chase.floor}.`;
  }
  if (chase.needs === 0) {
    return `${chaser.name} is already level with or ahead of ${target.name}’s floor: best case ${chase.best}, floor ${chase.floor}.`;
  }
  return `${chaser.name} needs +${chase.needs} on ${target.name} over the rounds left: best case ${chase.best}, ${target.name}’s floor ${chase.floor}.`;
}

/** The value a head-to-head select shows for one entrant and round: "", "p3", "dns" or "pts". */
export function headToHeadChoice(state: CalcState, entrantKey: string, roundIndex: number): string {
  const edit = state.edits.get(editKey({ entrantKey, roundIndex }));
  if (!edit) return '';
  if (edit.mode === 'points') return 'pts';
  return edit.position === null ? 'dns' : `p${edit.position}`;
}
