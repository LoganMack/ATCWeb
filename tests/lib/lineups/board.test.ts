/**
 * The Lineup Changes render model (U9, src/lib/lineups/board.ts): the empty-state messages and their order,
 * masking with board-local keys, car numbers per column, validated team colours, A to Z team order, line
 * endpoints and the summary (BR1.13 to BR1.23, US7.2, US7.4, US7.5).
 */
import { describe, expect, it } from 'vitest';
import {
  buildLineupBoard,
  linePath,
  lineupMessage,
  lineupSummary,
  type BoardInput,
  type LineupBoard,
  type LineupDriver,
} from '../../../src/lib/lineups/board';
import { classifyLineups, type LineupSeason, type RosterRow } from '../../../src/lib/lineups/classify';

const S17: LineupSeason = { id: 's17', number: 17, name: 'ATC17', is_current: false };
const S18: LineupSeason = { id: 's18', number: 18, name: 'ATC18', is_current: true };

const UUID = {
  carter: '11111111-0000-0000-0000-000000000001',
  ruiz: '11111111-0000-0000-0000-000000000002',
  petrov: '11111111-0000-0000-0000-000000000003',
  lind: '11111111-0000-0000-0000-000000000004',
  ghost: '11111111-0000-0000-0000-000000000005',
  novak: '11111111-0000-0000-0000-000000000006',
};
const TEAMS = [
  { id: 'redline', name: 'Redline', primary_color_hex: '#F5426E', logo_url: 'red.png' },
  { id: 'apex', name: 'apex Racing', primary_color_hex: '#4369f5', logo_url: 'apex.png' },
  { id: 'volt', name: 'Volt GP', primary_color_hex: '#fff;color:red', logo_url: null },
];
const driver = (
  key: keyof typeof UUID,
  name: string,
  car_number: number | null,
  is_hidden = false,
): LineupDriver => ({
  id: UUID[key],
  name,
  car_number,
  is_hidden,
});
const row = (s: LineupSeason, team: string, key: keyof typeof UUID): RosterRow => ({
  season_id: s.id,
  team_id: team,
  driver_id: UUID[key],
});

/** Carter stays at Apex, Ruiz moves Redline -> Apex, Petrov returns to Volt, Lind leaves Volt. */
function input(overrides: Partial<BoardInput> = {}, earlier: string[] = [UUID.petrov]): BoardInput {
  const current = [row(S18, 'apex', 'carter'), row(S18, 'apex', 'ruiz'), row(S18, 'volt', 'petrov')];
  const previous = [row(S17, 'apex', 'carter'), row(S17, 'redline', 'ruiz'), row(S17, 'volt', 'lind')];
  const teamName = (id: string) => TEAMS.find((t) => t.id === id)?.name ?? id;
  return {
    season: S18,
    previous: S17,
    classified: classifyLineups({ current, previous, earlierDriverIds: new Set(earlier), teamName }),
    teams: TEAMS,
    drivers: [
      driver('carter', 'Carter', 7),
      driver('ruiz', 'Ruiz', 30),
      driver('petrov', 'Petrov', 19),
      driver('lind', 'Lind', 88),
    ],
    currentNumbers: [{ driver_id: UUID.ruiz, car_number: 3 }],
    previousNumbers: [],
    seasonLogos: new Map([['apex:s17', 'apex-17.png']]),
    ...overrides,
  };
}

function board(i: BoardInput = input()): Extract<LineupBoard, { kind: 'board' }> {
  const b = buildLineupBoard(i);
  if (b.kind !== 'board') throw new Error(`expected a board, got: ${b.text}`);
  return b;
}
const seatsOf = (groups: { name: string; seats: { name: string }[] }[]) =>
  groups.map((g) => `${g.name}: ${g.seats.map((s) => s.name).join(', ')}`);

describe('messages (BR1.13)', () => {
  it('checks first season, then S without rosters, then S-1 without rosters', () => {
    expect(lineupMessage(S18, null, false, false)).toBe(
      "ATC18 is the first season, so there's no earlier lineup to compare with.",
    );
    expect(lineupMessage(S18, S17, false, false)).toBe('No lineups have been set for ATC18 yet.');
    expect(lineupMessage(S18, S17, true, false)).toBe(
      "No lineups were set for ATC17, so there's nothing to compare ATC18 with.",
    );
    expect(lineupMessage(S18, S17, true, true)).toBeNull();
    expect(lineupMessage(null, null, false, false)).toBe('No lineups have been set yet.');
  });

  it('returns the message instead of a board', () => {
    expect(buildLineupBoard(input({ previous: null }))).toEqual({
      kind: 'message',
      text: "ATC18 is the first season, so there's no earlier lineup to compare with.",
    });
    expect(buildLineupBoard(input({ classified: [] }))).toMatchObject({ kind: 'message' });
  });
});

describe('summary (BR1.14, BR1.23)', () => {
  it('counts moves, joiners with returning, and leavers', () => {
    expect(board().summary).toBe('1 moved team, 1 new to ATC (1 returning), 1 left ATC');
    expect(board(input({}, [])).summary).toBe('1 moved team, 1 new to ATC, 1 left ATC');
  });

  it('says nothing changed, dims every row and draws no line when everyone stayed', () => {
    const stayed = classifyLineups({
      current: [row(S18, 'apex', 'carter')],
      previous: [row(S17, 'apex', 'carter')],
      earlierDriverIds: new Set(),
      teamName: (id) => id,
    });
    const b = board(input({ classified: stayed }));
    expect(b.summary).toBe('No lineup changes from ATC17.');
    expect(b.lines).toEqual([]);
    expect([...b.left.groups, ...b.right.groups].flatMap((g) => g.seats).every((s) => s.key === null)).toBe(
      true,
    );
    expect(lineupSummary([], 'ATC1')).toBe('No lineup changes from ATC1.');
  });
});

describe('order (BR1.17, BR1.18)', () => {
  it('lists teams A to Z ignoring case in both columns, then the change groups', () => {
    const b = board();
    expect(seatsOf(b.left.groups)).toEqual([
      'apex Racing: Carter',
      'Redline: Ruiz',
      'Volt GP: Lind',
      'New to ATC: Petrov',
    ]);
    expect(seatsOf(b.right.groups)).toEqual([
      'apex Racing: Ruiz, Carter',
      'Volt GP: Petrov',
      'Left ATC: Lind',
    ]);
    expect(b.left.groups.map((g) => g.kind)).toEqual(['team', 'team', 'team', 'joined']);
    expect(b.right.groups.at(-1)?.kind).toBe('left');
  });

  it('gives the phone cards S teams only, and a Left ATC card', () => {
    const b = board();
    expect(seatsOf(b.cards)).toEqual(['apex Racing: Ruiz, Carter', 'Volt GP: Petrov']);
    expect(b.leftCard.map((s) => [s.name, s.tag])).toEqual([['Lind', 'was Volt GP']]);
    expect(b.cards[0].seats.map((s) => s.tag)).toEqual(['from Redline', null]);
    expect(b.cards[1].seats[0].tag).toBe('returning');
  });
});

describe('numbers, colours and logos (BR1.16, BR1.20, BR1.21)', () => {
  it("uses each column's season number, else the driver's own number", () => {
    const b = board();
    const ruizLeft = b.left.groups[1].seats[0];
    const ruizRight = b.right.groups[0].seats[0];
    expect([ruizLeft.number, ruizRight.number]).toEqual([30, 3]);
    expect(b.left.groups[0].seats[0].number).toBe(7);
  });

  it('keeps only valid #rrggbb colours, lower-cased, and drops anything else to null', () => {
    const b = board();
    expect(b.right.groups.map((g) => g.colour)).toEqual(['#4369f5', null, null]);
    expect(b.left.groups[1].colour).toBe('#f5426e');
    expect(b.lines.find((l) => !l.dashed && l.y1 > 12)?.colour).toBeNull(); // Petrov to Volt
  });

  it("shows each column's season logo, else the team's current logo", () => {
    const b = board();
    expect(b.left.groups[0].logoUrl).toBe('apex-17.png');
    expect(b.right.groups[0].logoUrl).toBe('apex.png');
    expect(b.right.groups[1].logoUrl).toBeNull();
  });
});

describe('masking (BR1.15, US7.5)', () => {
  it('shows a hidden driver as Hidden Driver with their number, no link and no id anywhere', () => {
    const drivers = input().drivers.map((d) =>
      d.id === UUID.ruiz ? { ...d, name: 'Hidden Driver', is_hidden: true } : d,
    );
    const b = board(input({ drivers }));
    const seats = [...b.left.groups, ...b.right.groups].flatMap((g) => g.seats).filter((s) => s.hidden);
    expect(seats).toHaveLength(2);
    for (const s of seats) {
      expect(s).toMatchObject({ name: 'Hidden Driver', href: null, key: 'd1' });
    }
    expect(seats.map((s) => s.number)).toEqual([30, 3]);
    expect(seats[0].label).toBe('Hidden Driver: Redline → apex Racing');
    expect(JSON.stringify(seats)).not.toContain(UUID.ruiz);
    expect(JSON.stringify({ ...b, left: null, right: null, cards: null })).not.toContain(UUID.ruiz);
  });

  it('links visible drivers and shows a driver missing from drivers_shown as Unknown driver', () => {
    const drivers = input().drivers.filter((d) => d.id !== UUID.lind);
    const b = board(input({ drivers }));
    expect(b.left.groups[0].seats[0].href).toBe(`/drivers/${UUID.carter}`);
    const lind = b.leftCard[0];
    expect(lind).toMatchObject({ name: 'Unknown driver', href: null, number: null, status: 'left' });
  });

  it('keys changed drivers d1, d2, ... in classification order and gives stayers no key', () => {
    const b = board();
    const keys = Object.fromEntries(b.right.groups.flatMap((g) => g.seats).map((s) => [s.name, s.key]));
    expect(keys).toEqual({ Carter: null, Ruiz: 'd1', Petrov: 'd2', Lind: 'd3' });
  });
});

describe('lines and labels (BR1.19, BR1.22)', () => {
  it('draws one line per change between the two seats, leavers dashed and grey', () => {
    const b = board();
    // Left: apex (Carter 1.5) | gap | Redline (Ruiz 5.5) | gap | Volt (Lind 9.5) | gap | heading, Petrov 16.5.
    // Right: apex (Ruiz 1.5, Carter 4.5) | gap | Volt (Petrov 8.5) | gap | heading, Lind 15.5.
    expect(b.lines).toEqual([
      { key: 'd1', y1: 5.5, y2: 1.5, colour: '#4369f5', dashed: false },
      { key: 'd2', y1: 16.5, y2: 8.5, colour: null, dashed: false },
      { key: 'd3', y1: 9.5, y2: 15.5, colour: null, dashed: true },
    ]);
    expect(b.height).toBe(18);
    expect(linePath(b.lines[0])).toBe('M0 5.5 C50 5.5 50 1.5 100 1.5');
  });

  it('gives every changed seat a sentence and a label, so a move is never colour-only', () => {
    const seats = Object.fromEntries(
      board()
        .right.groups.flatMap((g) => g.seats)
        .map((s) => [s.name, s]),
    );
    expect([seats.Ruiz.srText, seats.Ruiz.label]).toEqual([
      ', moved from Redline to apex Racing',
      'Ruiz: Redline → apex Racing',
    ]);
    expect([seats.Petrov.srText, seats.Petrov.label]).toEqual([
      ', returning to ATC, joined Volt GP',
      'Petrov: Returning → Volt GP',
    ]);
    expect([seats.Lind.srText, seats.Lind.label]).toEqual([
      ', left ATC, was Volt GP',
      'Lind: Volt GP → Left ATC',
    ]);
    expect([seats.Carter.srText, seats.Carter.label]).toEqual(['', '']);
    const fresh = board(input({}, [])).right.groups[1].seats[0];
    expect([fresh.srText, fresh.label, fresh.tag]).toEqual([
      ', new to ATC, joined Volt GP',
      'Petrov: New to ATC → Volt GP',
      'new',
    ]);
  });
});
