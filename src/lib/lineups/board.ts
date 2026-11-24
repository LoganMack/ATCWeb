/**
 * The Lineup Changes render model (U9, BR1.13 to BR1.23): the empty-state message, or the two columns, the
 * lines between them, the phone cards and the summary. Pure. Driver ids stay here: a seat carries a board-local
 * key (d1, d2, ...) and a profile link only for a visible driver, so a hidden driver's id never reaches markup.
 */
import { normaliseLogoColour } from '../circuitCategory';
import { driverHref, HIDDEN_DRIVER_NAME } from '../privacy';
import { resolveTeamLogo } from '../results/rows';
import type { Classified, LineupSeason, LineupStatus } from './classify';

export interface LineupTeam {
  id: string;
  name: string;
  primary_color_hex: string | null;
  logo_url: string | null;
}

/** A drivers_shown row: a hidden driver's name arrives already masked. */
export interface LineupDriver {
  id: string;
  name: string;
  car_number: number | null;
  is_hidden: boolean | null;
}

export interface SeasonCarNumber {
  driver_id: string;
  car_number: number;
}

export interface Seat {
  /** "d1", "d2", ... for a changed driver; null for a stayer. */
  key: string | null;
  name: string;
  /** null when hidden or unknown. */
  href: string | null;
  hidden: boolean;
  number: number | null;
  status: LineupStatus;
  /** The phone card's tag: "from Redline", "new", "returning", "was Volt GP". */
  tag: string | null;
  /** Read after the visible name, so it starts with a comma: ", moved from Redline to Apex Racing". */
  srText: string;
  /** The visible highlight label, "Ruiz: Redline → Apex Racing". */
  label: string;
  /** Row centre, in row units. */
  y: number;
}

export interface Group {
  kind: 'team' | 'joined' | 'left';
  name: string;
  /** Validated #rrggbb, else null (the muted token). */
  colour: string | null;
  logoUrl: string | null;
  seats: Seat[];
}

export interface Column {
  groups: Group[];
}

export interface Line {
  key: string;
  y1: number;
  y2: number;
  colour: string | null;
  dashed: boolean;
}

export type LineupBoard =
  | { kind: 'message'; text: string }
  | {
      kind: 'board';
      previousLabel: string;
      currentLabel: string;
      left: Column;
      right: Column;
      lines: Line[];
      summary: string;
      cards: Group[];
      leftCard: Seat[];
      height: number;
    };

export interface BoardInput {
  season: LineupSeason | null;
  previous: LineupSeason | null;
  classified: readonly Classified[];
  teams: readonly LineupTeam[];
  drivers: readonly LineupDriver[];
  currentNumbers: readonly SeasonCarNumber[];
  previousNumbers: readonly SeasonCarNumber[];
  seasonLogos: Map<string, string>;
}

/** A seat row is 3 units tall (h-9) and the gap between groups 1 unit (mt-3), so geometry holds at any zoom. */
export const ROW_UNITS = 3;
export const GAP_UNITS = 1;

export const JOINED_GROUP_NAME = 'New to ATC';
export const LEFT_GROUP_NAME = 'Left ATC';
const UNKNOWN_DRIVER = 'Unknown driver';
const UNKNOWN_TEAM = 'Unknown team';

/** The one message shown instead of the board, checked in this order (BR1.13). */
export function lineupMessage(
  season: LineupSeason | null,
  previous: LineupSeason | null,
  hasCurrent: boolean,
  hasPrevious: boolean,
): string | null {
  if (!season) return 'No lineups have been set yet.';
  if (!previous) return `${season.name} is the first season, so there's no earlier lineup to compare with.`;
  if (!hasCurrent) return `No lineups have been set for ${season.name} yet.`;
  if (!hasPrevious)
    return `No lineups were set for ${previous.name}, so there's nothing to compare ${season.name} with.`;
  return null;
}

/** The counts under the board (BR1.23), or the no-changes line (BR1.14). */
export function lineupSummary(classified: readonly Classified[], previousName: string): string {
  const count = (status: LineupStatus) => classified.filter((c) => c.status === status).length;
  const moved = count('moved');
  const joined = count('joined');
  const left = count('left');
  if (moved + joined + left === 0) return `No lineup changes from ${previousName}.`;
  const returning = classified.filter((c) => c.status === 'joined' && c.returning).length;
  const returningText = returning > 0 ? ` (${returning} returning)` : '';
  return `${moved} moved team, ${joined} new to ATC${returningText}, ${left} left ATC`;
}

/** An SVG path from the left edge at y1 to the right edge at y2, in the board's 100-wide viewBox. */
export function linePath(line: Pick<Line, 'y1' | 'y2'>): string {
  const y1 = line.y1.toFixed(1);
  const y2 = line.y2.toFixed(1);
  return `M0 ${y1} C50 ${y1} 50 ${y2} 100 ${y2}`;
}

const prevTeamOf = (c: Classified) => (c.status === 'stayed' ? c.toTeamId : c.fromTeamId);

function byNumberThenName(a: Seat, b: Seat): number {
  if (a.number !== b.number) {
    if (a.number === null) return 1;
    if (b.number === null) return -1;
    return a.number - b.number;
  }
  return a.name.localeCompare(b.name);
}

export function buildLineupBoard(input: BoardInput): LineupBoard {
  const { season, previous, classified } = input;
  const message = lineupMessage(
    season,
    previous,
    classified.some((c) => c.toTeamId !== null),
    classified.some((c) => prevTeamOf(c) !== null),
  );
  if (message || !season || !previous) return { kind: 'message', text: message ?? '' };

  const teams = new Map(input.teams.map((t) => [t.id, t]));
  const drivers = new Map(input.drivers.map((d) => [d.id, d]));
  const currentNumbers = new Map(input.currentNumbers.map((n) => [n.driver_id, n.car_number]));
  const previousNumbers = new Map(input.previousNumbers.map((n) => [n.driver_id, n.car_number]));
  const teamName = (id: string | null) => (id ? (teams.get(id)?.name ?? UNKNOWN_TEAM) : UNKNOWN_TEAM);
  const colourOf = (id: string | null) => (id ? normaliseLogoColour(teams.get(id)?.primary_color_hex) : null);
  const logoOf = (id: string, seasonId: string) => {
    const team = teams.get(id);
    return team ? resolveTeamLogo(team, seasonId, input.seasonLogos) : null;
  };

  // One shared team order for both columns: A to Z by name (BR1.17, Q2 A).
  const teamIds = new Set<string>();
  for (const c of classified) {
    const before = prevTeamOf(c);
    if (before) teamIds.add(before);
    if (c.toTeamId) teamIds.add(c.toTeamId);
  }
  const order = [...teamIds].sort(
    (a, b) => teamName(a).toLowerCase().localeCompare(teamName(b).toLowerCase()) || a.localeCompare(b),
  );
  const position = new Map(order.map((id, i) => [id, i]));

  const keys = new Map<string, string>();
  for (const c of classified) if (c.status !== 'stayed') keys.set(c.driverId, `d${keys.size + 1}`);

  function seat(c: Classified, numbers: Map<string, number>): Seat {
    const shown = drivers.get(c.driverId);
    const hidden = shown?.is_hidden === true;
    const name = !shown ? UNKNOWN_DRIVER : hidden ? HIDDEN_DRIVER_NAME : shown.name;
    // A hidden driver's number still shows, as on standings and results (BR1.16, Q1 A); an unknown one has none.
    const number = shown ? (numbers.get(c.driverId) ?? shown.car_number ?? null) : null;
    const from = teamName(c.fromTeamId);
    const to = teamName(c.toTeamId);
    const text = {
      stayed: { tag: null, srText: '', label: '' },
      moved: {
        tag: `from ${from}`,
        srText: `, moved from ${from} to ${to}`,
        label: `${name}: ${from} → ${to}`,
      },
      joined: c.returning
        ? {
            tag: 'returning',
            srText: `, returning to ATC, joined ${to}`,
            label: `${name}: Returning → ${to}`,
          }
        : { tag: 'new', srText: `, new to ATC, joined ${to}`, label: `${name}: New to ATC → ${to}` },
      left: { tag: `was ${from}`, srText: `, left ATC, was ${from}`, label: `${name}: ${from} → Left ATC` },
    }[c.status];
    return {
      key: keys.get(c.driverId) ?? null,
      name,
      href: shown ? driverHref({ id: shown.id, is_hidden: hidden }) : null,
      hidden,
      number,
      status: c.status,
      ...text,
      y: 0,
    };
  }

  function teamGroups(
    member: (c: Classified) => string | null,
    numbers: Map<string, number>,
    seasonId: string,
  ) {
    return order
      .map((id): Group => ({
        kind: 'team',
        name: teamName(id),
        colour: colourOf(id),
        logoUrl: logoOf(id, seasonId),
        seats: classified
          .filter((c) => member(c) === id)
          .map((c) => seat(c, numbers))
          .sort(byNumberThenName),
      }))
      .filter((g) => g.seats.length > 0);
  }

  function changeGroup(
    kind: 'joined' | 'left',
    teamOf: (c: Classified) => string | null,
    numbers: Map<string, number>,
  ) {
    const seats = classified
      .filter((c) => c.status === kind)
      .map((c) => ({ pos: position.get(teamOf(c) ?? '') ?? order.length, seat: seat(c, numbers) }))
      .sort((a, b) => a.pos - b.pos || byNumberThenName(a.seat, b.seat))
      .map((s) => s.seat);
    const name = kind === 'joined' ? JOINED_GROUP_NAME : LEFT_GROUP_NAME;
    return seats.length > 0 ? [{ kind, name, colour: null, logoUrl: null, seats } satisfies Group] : [];
  }

  // Left: S-1's teams, then the joiners (with S numbers). Right: S's teams, then the leavers (with S-1 numbers).
  const leftGroups = [
    ...teamGroups(prevTeamOf, previousNumbers, previous.id),
    ...changeGroup('joined', (c) => c.toTeamId, currentNumbers),
  ];
  const rightGroups = [
    ...teamGroups((c) => c.toTeamId, currentNumbers, season.id),
    ...changeGroup('left', (c) => c.fromTeamId, previousNumbers),
  ];
  const leftHeight = place(leftGroups);
  const rightHeight = place(rightGroups);

  const leftY = seatYByKey(leftGroups);
  const rightY = seatYByKey(rightGroups);
  const lines: Line[] = [];
  for (const c of classified) {
    const key = keys.get(c.driverId);
    if (!key) continue;
    lines.push({
      key,
      y1: leftY.get(key) ?? 0,
      y2: rightY.get(key) ?? 0,
      colour: c.status === 'left' ? null : colourOf(c.toTeamId),
      dashed: c.status === 'left',
    });
  }

  return {
    kind: 'board',
    previousLabel: previous.name,
    currentLabel: season.name,
    left: { groups: leftGroups },
    right: { groups: rightGroups },
    lines,
    summary: lineupSummary(classified, previous.name),
    cards: rightGroups.filter((g) => g.kind === 'team'),
    leftCard: rightGroups.find((g) => g.kind === 'left')?.seats ?? [],
    height: Math.max(leftHeight, rightHeight),
  };
}

/**
 * Sets each seat's row centre and returns the column height. The "New to ATC" and "Left ATC" groups open with
 * a heading row of the same height as a seat.
 */
function place(groups: Group[]): number {
  let y = 0;
  groups.forEach((group, i) => {
    if (i > 0) y += GAP_UNITS;
    if (group.kind !== 'team') y += ROW_UNITS;
    for (const s of group.seats) {
      s.y = y + ROW_UNITS / 2;
      y += ROW_UNITS;
    }
  });
  return y;
}

function seatYByKey(groups: Group[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of groups) for (const s of g.seats) if (s.key) out.set(s.key, s.y);
  return out;
}
