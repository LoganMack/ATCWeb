/**
 * Points Contenders in the browser (src/scripts/pointsCalculatorModel.ts, pointsCalculatorView.ts,
 * pointsCalculatorEditor.ts, pointsCalculator.ts; FR2-FR4, FR8, NFR3): an edit moves the bars, Undo and Reset,
 * the status tags, the Pts column and the Best Possible label, the per-race segments of the current total, the typed-points rule that
 * disables Apply, the team editor's top-two re-pick, the bars' markup (one Leader's Floor line), the Scenario
 * Editor popup (a draft until Save, dropped on Close or Escape, Reset clearing every edit), and a full
 * recompute for 60 drivers over 12 rounds inside 100 ms. Vitest runs in Node with no DOM, so the markup and
 * the popups are built into a small fake document (tests/scripts/fakeDom.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  barSegments,
  barViews,
  contendersFloor,
  createState,
  draftEdit,
  draftState,
  initialDraft,
  matrixRows,
  parseCalculatorSeason,
  parseTypedPoints,
  positionOptions,
  recompute,
  resetEdits,
  saveDraft,
  setEdit,
  teamLines,
  undoEdit,
} from '../../src/scripts/pointsCalculatorModel';
import type {
  CalculatorEntrant,
  CalculatorRound,
  CalculatorSeason,
  Edit,
} from '../../src/lib/calculator/types';
import { installFakeDom, type FakeDocument, type FakeElement } from './fakeDom';

const TABLE = { finish: [50, 40, 30, 20, 10], classifiedMinimum: 1, classPoints: [] };
const NO_TIEBREAK = {
  wins: 0,
  podiums: 0,
  top5s: 0,
  top10s: 0,
  poles: 0,
  lapsLed: 0,
  laps: 0,
  appearances: 0,
};

function round(
  index: number,
  state: CalculatorRound['state'],
  over: Partial<CalculatorRound> = {},
): CalculatorRound {
  return {
    index,
    label: `R${index} · Track ${index}`,
    short: `R${index}`,
    order: index,
    state,
    format: state === 'special' ? 'special' : 'endurance',
    races: 1,
    tables: state === 'special' ? [] : [TABLE],
    bestCase: state === 'special' ? 0 : 50,
    secondPlaceCase: state === 'special' ? 0 : 40,
    soloBestCase: 50,
    soloSecondPlaceCase: 40,
    isFinal: false,
    ...over,
  };
}

function entrant(
  key: string,
  roundPoints: (number | null)[],
  over: Partial<CalculatorEntrant> = {},
): CalculatorEntrant {
  return { key, name: key.toUpperCase(), roundPoints, tiebreak: NO_TIEBREAK, ...over };
}

function season(
  rounds: CalculatorRound[],
  entrants: CalculatorEntrant[],
  over: Partial<CalculatorSeason> = {},
): CalculatorSeason {
  return {
    seasonId: 's18',
    seasonName: 'ATC18',
    championship: 'overall',
    championshipLabel: 'Overall',
    isTeam: false,
    rounds,
    entrants,
    dropCount: 0,
    dropsFromRounds: 5,
    canDropFinalRound: false,
    ...over,
  };
}

/** Two run rounds, a special round and a final round still to run. */
const BASE = season(
  [round(1, 'completed'), round(2, 'completed'), round(3, 'special'), round(4, 'future')],
  [
    entrant('ann', [50, 40, null, null]),
    entrant('bob', [40, 30, null, null]),
    entrant('cy', [10, 10, null, null]),
  ],
);

const edit = (over: Partial<Edit>): Edit => ({
  entrantKey: 'bob',
  roundIndex: 4,
  mode: 'position',
  position: 1,
  points: 50,
  ...over,
});

describe('the edit set', () => {
  it('moves the bars after an edit, and Undo puts them back', () => {
    const state = createState(BASE);
    const before = barViews(state, recompute(state));
    expect(before.map((b) => [b.key, b.chip.label, b.points, b.bestLabel])).toEqual([
      ['ann', 'Leader', '90', 'Best Possible: 140 pts'],
      ['bob', 'Contending', '70', 'Best Possible: 120 pts'],
      ['cy', 'Eliminated (Round 2)', '20', 'Best Possible: 70 pts'],
    ]);
    expect(contendersFloor(state, recompute(state)).floor).toBe(90);

    setEdit(state, edit({}));
    const after = barViews(state, recompute(state));
    expect(after.find((b) => b.key === 'bob')!.points).toBe('120');
    expect(after.map((b) => b.chip.label)).toEqual(['Champion', 'P2', 'P3']);
    expect(after[0].ariaLabel).toBe(
      'BOB, champion, 120 points, counted: R1 · Track 1, 40; R2 · Track 2, 30; R4 · Track 4, 50',
    );
    expect(contendersFloor(state, recompute(state)).floor).toBeNull();

    undoEdit(state, { entrantKey: 'bob', roundIndex: 4 });
    expect(barViews(state, recompute(state))).toEqual(before);
  });

  it('shows a row on no points as 0 in the Pts column, with no arrow or gap text (BR1.1, BR1.2)', () => {
    const s = season(BASE.rounds, [...BASE.entrants, entrant('dee', [null, null, null, null])]);
    const bars = barViews(createState(s), recompute(createState(s)));
    const dee = bars.find((b) => b.key === 'dee')!;
    expect(dee.points).toBe('0');
    expect(dee.bestLabel).toBe('Best Possible: 50 pts');
    for (const b of bars) {
      expect(Object.keys(b)).not.toContain('numbers');
      expect(Object.keys(b)).not.toContain('needs');
      expect(b.points).toMatch(/^\d+$/);
    }
  });

  it('labels a finished row’s best possible with its counted total (BR1.3, AC2.2.3)', () => {
    const state = createState(BASE);
    setEdit(state, edit({}));
    const bars = barViews(state, recompute(state));
    expect(bars.map((b) => [b.key, b.chip.label, b.points, b.bestLabel])).toEqual([
      ['bob', 'Champion', '120', 'Best Possible: 120 pts'],
      ['ann', 'P2', '90', 'Best Possible: 90 pts'],
      ['cy', 'P3', '20', 'Best Possible: 20 pts'],
    ]);
  });

  it('keeps the plain Eliminated tag in the results matrix while the bar names the round (BR1.4)', () => {
    const state = createState(BASE);
    const snapshot = recompute(state);
    expect(barViews(state, snapshot)[2].chip).toEqual({ label: 'Eliminated (Round 2)', tone: 'muted' });
    expect(matrixRows(state, snapshot)[2].status).toEqual({ label: 'Eliminated', tone: 'muted' });
  });

  it('shows no Eliminated tag when viewed as of a round before the elimination (BR1.6)', () => {
    // As of round 1: round 2 has not run yet, so CY can still reach 110 against ANN's 50.
    const asOfRound1 = season(
      [round(1, 'completed'), round(2, 'future'), round(3, 'special'), round(4, 'future')],
      [
        entrant('ann', [50, null, null, null]),
        entrant('bob', [40, null, null, null]),
        entrant('cy', [10, null, null, null]),
      ],
    );
    const bars = barViews(createState(asOfRound1), recompute(createState(asOfRound1)));
    const cy = bars.find((b) => b.key === 'cy')!;
    expect(cy.chip.label).toBe('Contending');
    expect(bars.some((b) => b.chip.label.startsWith('Eliminated'))).toBe(false);
    expect(cy.bestLabel).toBe('Best Possible: 110 pts');
  });

  it('names every status with the new labels, in the tags, the matrix and the text equivalent', () => {
    const state = createState(BASE);
    const bars = barViews(state, recompute(state));
    expect(bars[1].ariaLabel).toBe(
      'BOB, contending, 70 points, best possible 120, needs 20 more, counted: R1 · Track 1, 40; R2 · Track 2, 30',
    );
    expect(bars[2].ariaLabel).toMatch(/^CY, eliminated after round 2, 20 points, best possible 70/);
    expect(matrixRows(state, recompute(state)).map((r) => r.status.label)).toEqual([
      'Leader',
      'Contending',
      'Eliminated',
    ]);
    // A chaser who must win every round left.
    const tight = season(BASE.rounds, [
      entrant('ann', [50, 40, null, null]),
      entrant('bob', [40, 5, null, null]),
    ]);
    expect(barViews(createState(tight), recompute(createState(tight)))[1].chip).toEqual({
      label: 'Must Win Out',
      tone: 'pink',
    });
  });

  it('Reset clears every edit', () => {
    const state = createState(BASE);
    setEdit(state, edit({}));
    setEdit(state, edit({ entrantKey: 'ann', roundIndex: 1, position: 3, points: 30 }));
    expect(state.edits.size).toBe(2);
    resetEdits(state);
    expect(state.edits.size).toBe(0);
    expect(recompute(state).editedCells.size).toBe(0);
  });

  it('keeps a draft apart until Save', () => {
    const state = createState(BASE);
    setEdit(state, edit({ position: 2, points: 40 }));
    const draft = draftState(state);
    setEdit(draft, edit({ entrantKey: 'ann', roundIndex: 4, position: 5, points: 10 }));
    expect(state.edits.size).toBe(1);
    saveDraft(state, draft);
    expect(state.edits.size).toBe(2);
    resetEdits(draft);
    expect(state.edits.size).toBe(2);
  });

  it('marks dropped, edited, future and special cells in the matrix', () => {
    const s = season(BASE.rounds, BASE.entrants, {
      dropCount: 1,
      dropsFromRounds: 2,
      canDropFinalRound: true,
    });
    const state = createState(s);
    setEdit(state, edit({ entrantKey: 'ann', roundIndex: 2, position: 5, points: 10 }));
    const ann = matrixRows(state, recompute(state)).find((r) => r.key === 'ann')!;
    expect(ann.cells.map((c) => [c.text, c.state, c.edited])).toEqual([
      ['50', 'counted', false],
      ['10', 'dropped', true],
      ['—', 'special', false],
      ['+', 'future', false],
    ]);
    expect(ann.cells[1].ariaLabel).toBe('ANN, round 2: 10 points, dropped, edited');
    expect(ann.cells[2]).toMatchObject({ disabled: true, title: 'No points table for this format' });
  });

  it('shows everyone Contending before any round has a result (FR8.1)', () => {
    const fresh = season(
      [round(1, 'future'), round(2, 'future')],
      [entrant('ann', [null, null]), entrant('bob', [null, null])],
    );
    const state = createState(fresh);
    const bars = barViews(state, recompute(state));
    expect(bars.map((b) => b.chip.label)).toEqual(['Contending', 'Contending']);
    expect(bars.every((b) => b.countedPct === 0 && b.bestPct === 100 && b.segments.length === 0)).toBe(true);
  });
});

describe('the current total’s segments', () => {
  const twoRaces = (index: number, state: CalculatorRound['state']) =>
    round(index, state, { races: 2, tables: [TABLE, TABLE], bestCase: 100, secondPlaceCase: 80 });

  it('splits a round into its races when the breakdown adds up, and keeps a round whole otherwise', () => {
    const s = season(
      [twoRaces(1, 'completed'), twoRaces(2, 'completed'), twoRaces(3, 'future')],
      [
        entrant('ann', [50, 70, null], { racePoints: [[30, 20], null, null] }),
        // A breakdown that does not add up to the round's points is not trusted.
        entrant('bob', [40, 30, null], { racePoints: [[10, 10], [30, 0], null] }),
      ],
    );
    const state = createState(s);
    const snap = recompute(state);
    const ann = snap.rows.find((r) => r.key === 'ann')!;
    expect(barSegments(state, snap, ann).map((x) => [x.label, x.points])).toEqual([
      ['R1 · Track 1 · Race 1', 30],
      ['R1 · Track 1 · Race 2', 20],
      ['R2 · Track 2', 70],
    ]);
    const bob = snap.rows.find((r) => r.key === 'bob')!;
    // R1's breakdown is wrong, so it stays whole; R2's race with no points has no segment.
    expect(barSegments(state, snap, bob).map((x) => [x.label, x.points])).toEqual([
      ['R1 · Track 1', 40],
      ['R2 · Track 2 · Race 1', 30],
    ]);
    // Widths are on the shared scale: ann's best case (120 + 100) is the largest.
    expect(barSegments(state, snap, ann)[0].pct).toBeCloseTo((30 / 220) * 100, 5);
  });

  it('prices an edited round per race in position mode and keeps typed points whole', () => {
    const s = season(
      [twoRaces(1, 'completed'), twoRaces(2, 'future')],
      [entrant('ann', [50, null]), entrant('bob', [40, null])],
    );
    const state = createState(s);
    setEdit(state, { entrantKey: 'ann', roundIndex: 2, mode: 'position', position: 2, points: 80 });
    setEdit(state, { entrantKey: 'bob', roundIndex: 2, mode: 'points', position: null, points: 77 });
    const snap = recompute(state);
    expect(
      barSegments(
        state,
        snap,
        snap.rows.find((r) => r.key === 'ann')!,
      ).map((x) => [x.label, x.points]),
    ).toEqual([
      ['R1 · Track 1', 50],
      ['R2 · Track 2 · Race 1', 40],
      ['R2 · Track 2 · Race 2', 40],
    ]);
    expect(
      barSegments(
        state,
        snap,
        snap.rows.find((r) => r.key === 'bob')!,
      ).map((x) => x.label),
    ).toEqual(['R1 · Track 1', 'R2 · Track 2']);
  });

  it('leaves dropped rounds out, so the segments add up to the current total', () => {
    const s = season(BASE.rounds, BASE.entrants, {
      dropCount: 1,
      dropsFromRounds: 2,
      canDropFinalRound: true,
    });
    const state = createState(s);
    setEdit(state, edit({ entrantKey: 'ann', roundIndex: 2, position: 5, points: 10 }));
    const snap = recompute(state);
    const ann = snap.rows.find((r) => r.key === 'ann')!;
    const segments = barSegments(state, snap, ann);
    expect(segments.map((x) => x.label)).toEqual(['R1 · Track 1']);
    expect(segments.reduce((sum, x) => sum + x.points, 0)).toBe(ann.countedTotal);
  });

  it('gives a team one segment per race: its two best drivers’ points there', () => {
    const team = entrant('t1', [140, null], {
      members: [
        { key: 'm1', name: 'Mia', racePoints: [[50, 10], null] },
        { key: 'm2', name: 'Max', racePoints: [[40, 30], null] },
        { key: 'm3', name: 'Mo', racePoints: [[30, 20], null] },
      ],
    });
    const s = season(
      [twoRaces(1, 'completed'), twoRaces(2, 'future')],
      [team, entrant('t2', [60, null], { members: [] })],
      {
        isTeam: true,
        championship: 'alpha_team',
      },
    );
    const state = createState(s);
    const snap = recompute(state);
    expect(barSegments(state, snap, snap.rows[0]).map((x) => [x.label, x.points])).toEqual([
      ['R1 · Track 1 · Race 1', 90],
      ['R1 · Track 1 · Race 2', 50],
    ]);
  });
});

describe('the cell editor', () => {
  const r4 = BASE.rounds[3];

  it('offers P1..Pn with their points, then Did not race', () => {
    expect(positionOptions(r4, 3).map((o) => o.label)).toEqual([
      'P1 (50 pts)',
      'P2 (40 pts)',
      'P3 (30 pts)',
      'Did not race (0)',
    ]);
  });

  it('accepts whole numbers 0-999 only, so anything else keeps Apply disabled (BR3.10)', () => {
    for (const ok of ['0', '7', '999', ' 42 ']) expect(parseTypedPoints(ok), ok).not.toBeNull();
    for (const bad of ['', '-1', '1000', '2.5', '1e2', 'ten', '0x10'])
      expect(parseTypedPoints(bad), bad).toBeNull();
    expect(draftEdit(r4, { typed: true, choice: 'p1', text: '12.5' }, { entrantKey: 'bob' })).toBeNull();
    expect(draftEdit(r4, { typed: true, choice: 'p1', text: '77' }, { entrantKey: 'bob' })).toMatchObject({
      mode: 'points',
      points: 77,
    });
    expect(draftEdit(r4, { typed: false, choice: 'dns', text: '' }, { entrantKey: 'bob' })).toMatchObject({
      position: null,
      points: 0,
    });
  });

  it('opens on the cell’s own edit, else the option matching its points', () => {
    expect(initialDraft(r4, 40, undefined, 3)).toEqual({ typed: false, choice: 'p2', text: '' });
    expect(initialDraft(r4, 33, undefined, 3)).toEqual({ typed: true, choice: 'p1', text: '33' });
    expect(initialDraft(r4, null, undefined, 3).choice).toBe('dns');
    expect(initialDraft(r4, 40, edit({ mode: 'points', points: 9 }), 3)).toMatchObject({
      typed: true,
      text: '9',
    });
  });
});

describe('the team editor (FR2.9)', () => {
  const team = entrant('t1', [90, null], {
    members: [
      { key: 'm1', name: 'Mia', racePoints: [[50], null] },
      { key: 'm2', name: 'Max', racePoints: [[40], null] },
      { key: 'm3', name: 'Mo', racePoints: [[30], null] },
    ],
  });
  const teams = season(
    [round(1, 'completed'), round(2, 'future')],
    [team, entrant('t2', [80, null], { members: [] })],
    {
      isTeam: true,
      championship: 'alpha_team',
    },
  );

  it('re-picks the two counting drivers and the total as a draft changes, and Apply sets the team cell', () => {
    const state = createState(teams);
    const snapshot = recompute(state);
    const r1 = teams.rounds[0];
    const before = teamLines(state, snapshot, team, r1, new Map());
    expect(before.lines.map((l) => [l.name, l.counts])).toEqual([
      ['Mia', true],
      ['Max', true],
      ['Mo', false],
    ]);
    expect(before.total).toBe(90);
    const drafts = new Map([['m3', { typed: false, choice: 'p1', text: '' }]]);
    const after = teamLines(state, snapshot, team, r1, drafts);
    expect(after.lines.map((l) => l.counts)).toEqual([true, false, true]);
    expect(after.total).toBe(100);
    expect(
      teamLines(state, snapshot, team, r1, new Map([['m3', { typed: true, choice: 'p1', text: 'x' }]])).valid,
    ).toBe(false);

    setEdit(state, draftEdit(r1, drafts.get('m3')!, { entrantKey: 't1', memberKey: 'm3' })!);
    const applied = recompute(state);
    expect(applied.rows.find((r) => r.key === 't1')!.countedTotal).toBe(100);
    expect(teamLines(state, applied, team, r1, new Map()).lines[2]).toMatchObject({
      edited: true,
      counts: true,
    });
  });
});

describe('parseCalculatorSeason', () => {
  it('reads the embedded season and refuses anything malformed', () => {
    expect(parseCalculatorSeason(JSON.stringify(BASE))?.entrants).toHaveLength(3);
    for (const bad of [null, '', '{', '{"rounds":1}', '[]']) expect(parseCalculatorSeason(bad)).toBeNull();
  });
});

describe('recompute speed (NFR3)', () => {
  it('recomputes 60 drivers over 12 rounds in under 100 ms', () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const rounds = Array.from({ length: 12 }, (_, i) =>
      round(i + 1, i < 8 ? 'completed' : 'future', {
        races: 2,
        tables: [TABLE, TABLE],
        bestCase: 120,
        secondPlaceCase: 110,
      }),
    );
    const entrants = Array.from({ length: 60 }, (_, d) =>
      entrant(
        `d${d + 1}`,
        rounds.map((r) => (r.state === 'completed' && next() > 0.1 ? Math.floor(next() * 110) : null)),
      ),
    );
    const s = season(rounds, entrants, { dropCount: 2, dropsFromRounds: 5 });
    const state = createState(s);
    recompute(state); // warm-up, as the page does on load
    setEdit(state, edit({ entrantKey: 'd30', roundIndex: 10, position: 1, points: 100 }));
    const start = performance.now();
    const snapshot = recompute(state);
    barViews(state, snapshot);
    matrixRows(state, snapshot);
    const ms = performance.now() - start;
    expect(snapshot.rows).toHaveLength(60);
    expect(ms).toBeLessThan(100);
  });
});

// --- Markup and popups, in a small fake document --------------------------------------------------------------

describe('the bars’ markup', () => {
  beforeEach(() => {
    installFakeDom();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('draws one Leader’s Floor line over every bar, same-width tracks and Pos, Name, Pts, Status, bar', async () => {
    const { contendersSection } = await import('../../src/scripts/pointsCalculatorView');
    const state = createState(BASE);
    const section = contendersSection(state, recompute(state)) as unknown as FakeElement;

    const lines = section.querySelectorAll('[data-floor-line]');
    expect(lines).toHaveLength(1);
    expect(lines[0].getAttribute('aria-label')).toBe('Leader’s Floor: 90');
    expect(lines[0].getAttribute('data-tip')).toBe('Leader’s Floor: 90');
    expect(lines[0].getAttribute('style')).toBe(`left:${((90 / 140) * 100).toFixed(2)}%`);

    // The overlay and every row share the same columns, so the bars line up under the line.
    const overlay = section.querySelector('[data-floor-overlay]')!;
    const columns = (n: FakeElement) => n.classes.filter((c) => c.includes('grid-cols-'));
    const rows = section.querySelectorAll('[data-bar]');
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(columns(row)).toEqual(columns(overlay));
    expect(columns(overlay)).toContain('md:grid-cols-[2rem_11rem_3.5rem_11rem_minmax(0,1fr)]');
    // Four spacers, then the bar column that holds the line.
    expect(overlay.children).toHaveLength(5);
    expect(overlay.children[4].querySelector('[data-floor-line]')).not.toBeNull();

    // Each row: Pos, then name, Pts and status (one wrapper, md:contents), then the bar; no right column.
    const bob = section.querySelector('[data-bar="bob"]')!;
    const [, pos, nameLine, track] = bob.children;
    expect(bob.children).toHaveLength(4);
    expect(pos.textContent).toBe('2');
    expect(nameLine.classes).toContain('md:contents');
    expect(nameLine.children.map((c) => c.textContent)).toEqual(['BOB', '70', 'Contending']);
    expect(nameLine.children[1].hasAttribute('data-bar-points')).toBe(true);
    expect(track.hasAttribute('data-bar-track')).toBe(true);
    const cy = section.querySelector('[data-bar="cy"]')!;
    expect(cy.querySelector('[data-bar-points]')!.textContent).toBe('20');
    expect(cy.querySelector('[data-status-chip]')!.textContent).toBe('Eliminated (Round 2)');
    // No gap, round or current-to-best text anywhere outside the screen-reader sentences.
    for (const row of rows) {
      const visible = row.children.filter((c) => !c.hasAttribute('data-bar-text')).map((c) => c.textContent);
      expect(visible.join(' ')).not.toMatch(/→|\+\d|\bR\d/);
    }
    expect(section.querySelectorAll('[data-bar-numbers]')).toHaveLength(0);
    expect(section.querySelectorAll('[data-bar-needs]')).toHaveLength(0);

    // Segments carry their race and points; the row's text equivalent says the same.
    const segments = bob.querySelectorAll('[data-bar-segment]');
    expect(segments.map((s) => s.getAttribute('data-tip'))).toEqual([
      'R1 · Track 1: 40 pts',
      'R2 · Track 2: 30 pts',
    ]);
    expect(bob.querySelector('[data-bar-text]')!.textContent).toContain(
      'counted: R1 · Track 1, 40; R2 · Track 2, 30',
    );

    // The legend's three labels; no subtitle and no buttons (Show as table and Edit results are gone).
    expect(section.querySelector('[data-contenders-legend]')!.children.map((c) => c.textContent)).toEqual([
      'Current Points',
      'Best Possible',
      'Leader’s Floor',
    ]);
    expect(section.querySelectorAll('button')).toHaveLength(0);
    expect(
      section.querySelectorAll('p').filter((p) => !p.hasAttribute('data-contenders-legend')),
    ).toHaveLength(0);
  });

  it('makes the best-possible part a focusable, labelled image outside every aria-hidden part', async () => {
    const { contendersSection } = await import('../../src/scripts/pointsCalculatorView');
    const state = createState(BASE);
    const section = contendersSection(state, recompute(state)) as unknown as FakeElement;
    const bob = section.querySelector('[data-bar="bob"]')!;

    const best = bob.querySelector('[data-bar-best]')!;
    expect(best.getAttribute('tabindex')).toBe('0');
    expect(best.getAttribute('role')).toBe('img');
    expect(best.getAttribute('aria-label')).toBe('Best Possible: 120 pts');
    expect(best.getAttribute('data-tip')).toBe('Best Possible: 120 pts');
    expect(best.closest('[aria-hidden]')).toBeNull();

    // The segments are decorative to assistive tech and let the pointer fall through to the best part.
    const segments = bob.querySelector('[data-bar-segments]')!;
    expect(segments.getAttribute('aria-hidden')).toBe('true');
    expect(segments.classes).toContain('pointer-events-none');
    expect(
      segments.querySelectorAll('[data-bar-segment]').every((s) => s.classes.includes('pointer-events-auto')),
    ).toBe(true);
    // The row's sentence still carries the status and best possible for screen readers.
    expect(section.querySelector('[data-bar="cy"] [data-bar-text]')!.textContent).toMatch(
      /^CY, eliminated after round 2, 20 points, best possible 70/,
    );
  });

  it('shows the Best Possible tooltip on keyboard focus and hides it on blur', async () => {
    const { contendersSection } = await import('../../src/scripts/pointsCalculatorView');
    const state = createState(BASE);
    const section = contendersSection(state, recompute(state)) as unknown as FakeElement;
    const tip = section.querySelector('[data-bar-tip]')!;
    expect(tip.classes).toContain('hidden');

    const best = section.querySelector('[data-bar="ann"] [data-bar-best]')!;
    best.dispatch('focusin');
    expect(tip.classes).not.toContain('hidden');
    expect(tip.textContent).toBe('Best Possible: 140 pts');

    best.dispatch('focusout');
    expect(tip.classes).toContain('hidden');

    // Pointer over the best part shows the same text.
    best.dispatch('pointerover');
    expect(tip.textContent).toBe('Best Possible: 140 pts');
    expect(tip.classes).not.toContain('hidden');
  });

  it('makes every matrix cell a labelled button, the special round disabled, with no visible caption', async () => {
    const { matrixElement } = await import('../../src/scripts/pointsCalculatorView');
    const state = createState(BASE);
    setEdit(state, edit({}));
    const root = matrixElement(BASE, matrixRows(state, recompute(state))) as unknown as FakeElement;
    const buttons = root.querySelectorAll('button');
    expect(buttons).toHaveLength(12);
    const bob4 = root.querySelector('[data-cell-entrant="bob"][data-cell-round="4"]')!;
    expect(bob4.getAttribute('aria-label')).toBe('BOB, round 4: 50 points, edited');
    expect(bob4.getAttribute('data-edited')).toBe('true');
    const special = buttons.filter((b) => b.getAttribute('data-cell-round') === '3');
    expect(
      special.every((b) => b.disabled && b.getAttribute('title') === 'No points table for this format'),
    ).toBe(true);
    expect(root.querySelectorAll('caption')).toHaveLength(0);
    expect(root.querySelector('table')!.getAttribute('aria-label')).toBe(
      'Overall championship, ATC18, results by round',
    );
    // Names are text nodes, never markup.
    expect(root.querySelectorAll('th[scope="row"]').map((n) => n.textContent)).toEqual(['BOB', 'ANN', 'CY']);
  });
});

describe('the Scenario Editor popup', () => {
  let doc: FakeDocument;
  let openButton: FakeElement;
  let page: FakeElement;

  beforeEach(() => {
    doc = installFakeDom();
    openButton = doc.createElement('button');
    openButton.setAttribute('data-scenario-editor-open', '');
    page = doc.createElement('div');
    doc.body.append(openButton, page);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function open(state = createState(BASE)) {
    const { openScenario } = await import('../../src/scripts/pointsCalculator');
    const c = { root: page, body: page, status: null, state, snapshot: recompute(state) };
    openButton.focus();
    openScenario(c as never);
    const dialog = doc.body.querySelector('[data-scenario-editor]')!;
    return { state, dialog };
  }

  /** Sets bob's round 4 to P1 through the cell editor that opens over the Scenario Editor. */
  function editBobRound4(dialog: FakeElement) {
    dialog.querySelector('[data-cell-entrant="bob"][data-cell-round="4"]')!.click();
    const cellEditor = doc.body.querySelector('[data-calculator-editor]')!;
    expect(cellEditor.open).toBe(true);
    const select = cellEditor.querySelector('[data-editor-position]')!;
    select.value = 'p1';
    select.dispatch('change');
    cellEditor.querySelector('[data-editor-apply]')!.click();
    expect(doc.body.querySelector('[data-calculator-editor]')).toBeNull();
  }

  it('opens as a modal with Reset and Save in its header and the results table inside', async () => {
    const { dialog } = await open();
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector('h2')!.textContent).toBe('Scenario Editor');
    const header = dialog.children[0];
    const buttons = header.querySelectorAll('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Reset', 'Save', 'Close']);
    expect(buttons.every((b) => b.classes.includes('btn'))).toBe(true);
    expect(dialog.querySelector('[data-scenario-reset]')!.disabled).toBe(true);
    expect(dialog.querySelectorAll('[data-results-matrix]')).toHaveLength(1);
    // Focus moves into the popup.
    expect(dialog.contains(doc.activeElement)).toBe(true);
  });

  it('keeps cell edits in the popup until Save, then puts them on the bars and returns focus', async () => {
    const { state, dialog } = await open();
    editBobRound4(dialog);
    // The table shows the edit and focus is back on the cell; the page's edits have not changed yet.
    expect(dialog.querySelector('[data-matrix-total="bob"]')!.textContent).toBe('120');
    expect(doc.activeElement?.getAttribute('data-cell-entrant')).toBe('bob');
    expect(state.edits.size).toBe(0);
    expect(dialog.querySelector('[data-scenario-reset]')!.disabled).toBe(false);

    dialog.querySelector('[data-scenario-save]')!.click();
    expect(state.edits.size).toBe(1);
    expect(doc.body.querySelector('[data-scenario-editor]')).toBeNull();
    expect(doc.activeElement).toBe(openButton);
    expect(page.querySelector('[data-bar="bob"] [data-bar-points]')!.textContent).toBe('120');
    expect(page.querySelector('[data-bar="bob"] [data-bar-best]')!.getAttribute('aria-label')).toBe(
      'Best Possible: 120 pts',
    );
  });

  it('drops the session’s changes when closed without Save (Close or Escape)', async () => {
    const first = await open();
    editBobRound4(first.dialog);
    first.dialog.querySelector('[data-scenario-close]')!.click();
    expect(first.state.edits.size).toBe(0);
    expect(doc.body.querySelector('[data-scenario-editor]')).toBeNull();
    expect(doc.activeElement).toBe(openButton);

    // Escape closes a native modal dialog the same way: a close event with no Save.
    const second = await open(first.state);
    editBobRound4(second.dialog);
    second.dialog.close();
    expect(second.state.edits.size).toBe(0);
    expect(doc.activeElement).toBe(openButton);
  });

  it('Reset clears every edit, saved ones included, once saved', async () => {
    const state = createState(BASE);
    setEdit(state, edit({ position: 3, points: 30 }));
    const { dialog } = await open(state);
    expect(dialog.querySelectorAll('[data-edited="true"]')).toHaveLength(1);
    dialog.querySelector('[data-scenario-reset]')!.click();
    expect(dialog.querySelectorAll('[data-edited="true"]')).toHaveLength(0);
    expect(dialog.querySelector('[data-scenario-reset]')!.disabled).toBe(true);
    expect(doc.activeElement?.getAttribute('data-scenario-save')).toBe('');
    expect(state.edits.size).toBe(1);
    dialog.querySelector('[data-scenario-save]')!.click();
    expect(state.edits.size).toBe(0);
  });
});
