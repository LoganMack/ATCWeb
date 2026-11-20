/**
 * The points calculator in the browser (src/scripts/pointsCalculatorModel.ts, pointsCalculatorView.ts; FR2-FR5,
 * FR8, NFR3): an edit moves the bars, Undo and Reset, the typed-points rule that disables Apply, the shared
 * edit set across the two views, the Chaser and Target swap, the one-entrant state, the team editor's top-two
 * re-pick, the matrix markup, and a full recompute for 60 drivers over 12 rounds inside 100 ms. Vitest runs
 * in Node with no DOM, so the markup test builds into a small fake document.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  barViews,
  contendersHeader,
  createState,
  draftEdit,
  initialDraft,
  matrixRows,
  parseCalculatorSeason,
  parseTypedPoints,
  pick,
  positionOptions,
  recompute,
  resetEdits,
  scenarioModel,
  setEdit,
  teamLines,
  undoEdit,
} from '../../src/scripts/pointsCalculatorModel';
import type { CalculatorEntrant, CalculatorRound, CalculatorSeason, Edit } from '../../src/lib/calculator/types';

const TABLE = { finish: [50, 40, 30, 20, 10], classifiedMinimum: 1, classPoints: [] };
const NO_TIEBREAK = { wins: 0, podiums: 0, top5s: 0, top10s: 0, poles: 0, lapsLed: 0, laps: 0, appearances: 0 };

function round(index: number, state: CalculatorRound['state'], over: Partial<CalculatorRound> = {}): CalculatorRound {
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

function entrant(key: string, roundPoints: (number | null)[], over: Partial<CalculatorEntrant> = {}): CalculatorEntrant {
  return { key, name: key.toUpperCase(), roundPoints, tiebreak: NO_TIEBREAK, ...over };
}

function season(rounds: CalculatorRound[], entrants: CalculatorEntrant[], over: Partial<CalculatorSeason> = {}): CalculatorSeason {
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
  [entrant('ann', [50, 40, null, null]), entrant('bob', [40, 30, null, null]), entrant('cy', [10, 10, null, null])],
);

const edit = (over: Partial<Edit>): Edit => ({ entrantKey: 'bob', roundIndex: 4, mode: 'position', position: 1, points: 50, ...over });

describe('the shared edit set', () => {
  it('moves the bars and the header after an edit, and Undo puts them back', () => {
    const state = createState(BASE, 'contenders');
    const before = barViews(recompute(state));
    expect(before.map((b) => [b.key, b.chip.label])).toEqual([
      ['ann', 'Leader'],
      ['bob', 'In contention'],
      ['cy', 'Out · R2'],
    ]);
    expect(contendersHeader(state, recompute(state)).text).toBe('1 round left · up to 50 points a round · no drops');

    setEdit(state, edit({}));
    const after = barViews(recompute(state));
    expect(after.find((b) => b.key === 'bob')!.numbers).toBe('120');
    expect(after.map((b) => b.chip.label)).toEqual(['Champion', 'P2', 'P3']);
    expect(after[0].ariaLabel).toBe('BOB, 120 points, champion');

    undoEdit(state, { entrantKey: 'bob', roundIndex: 4 });
    expect(barViews(recompute(state))).toEqual(before);
  });

  it('Reset clears every edit in both views', () => {
    const state = createState(BASE, 'contenders');
    setEdit(state, edit({}));
    setEdit(state, edit({ entrantKey: 'ann', roundIndex: 1, position: 3, points: 30 }));
    state.view = 'scenarios';
    expect(state.edits.size).toBe(2);
    resetEdits(state);
    expect(state.edits.size).toBe(0);
    expect(recompute(state).editedCells.size).toBe(0);
  });

  it('keeps the edits when the view swaps between Contenders and Scenarios', () => {
    const state = createState(BASE, 'contenders');
    setEdit(state, edit({ position: 2, points: 40 }));
    state.view = 'scenarios';
    const snapshot = recompute(state);
    expect(snapshot.editedCells).toEqual(new Set(['bob|4']));
    expect(scenarioModel(state, snapshot).chaser).toMatchObject({ key: 'bob', now: 70, final: 110 });
  });

  it('marks dropped, edited, future and special cells in the matrix', () => {
    const s = season(BASE.rounds, BASE.entrants, { dropCount: 1, dropsFromRounds: 2, canDropFinalRound: true });
    const state = createState(s, 'contenders');
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

  it('shows everyone In contention before any round has a result (FR8.1)', () => {
    const fresh = season([round(1, 'future'), round(2, 'future')], [entrant('ann', [null, null]), entrant('bob', [null, null])]);
    const bars = barViews(recompute(createState(fresh, 'contenders')));
    expect(bars.map((b) => b.chip.label)).toEqual(['In contention', 'In contention']);
    expect(bars.every((b) => b.countedPct === 0 && b.bestPct === 100)).toBe(true);
  });
});

describe('the cell editor', () => {
  const r4 = BASE.rounds[3];

  it('offers P1..Pn with their points, then Did not race', () => {
    expect(positionOptions(r4, 3).map((o) => o.label)).toEqual(['P1 (50 pts)', 'P2 (40 pts)', 'P3 (30 pts)', 'Did not race (0)']);
  });

  it('accepts whole numbers 0-999 only, so anything else keeps Apply disabled (BR3.10)', () => {
    for (const ok of ['0', '7', '999', ' 42 ']) expect(parseTypedPoints(ok), ok).not.toBeNull();
    for (const bad of ['', '-1', '1000', '2.5', '1e2', 'ten', '0x10']) expect(parseTypedPoints(bad), bad).toBeNull();
    expect(draftEdit(r4, { typed: true, choice: 'p1', text: '12.5' }, { entrantKey: 'bob' })).toBeNull();
    expect(draftEdit(r4, { typed: true, choice: 'p1', text: '77' }, { entrantKey: 'bob' })).toMatchObject({
      mode: 'points',
      points: 77,
    });
    expect(draftEdit(r4, { typed: false, choice: 'dns', text: '' }, { entrantKey: 'bob' })).toMatchObject({ position: null, points: 0 });
  });

  it('opens on the cell’s own edit, else the option matching its points', () => {
    expect(initialDraft(r4, 40, undefined, 3)).toEqual({ typed: false, choice: 'p2', text: '' });
    expect(initialDraft(r4, 33, undefined, 3)).toEqual({ typed: true, choice: 'p1', text: '33' });
    expect(initialDraft(r4, null, undefined, 3).choice).toBe('dns');
    expect(initialDraft(r4, 40, edit({ mode: 'points', points: 9 }), 3)).toMatchObject({ typed: true, text: '9' });
  });
});

describe('Points Scenarios', () => {
  it('defaults Chaser to P2 and Target to P1, and swaps them when the same entrant is picked', () => {
    const state = createState(BASE, 'scenarios');
    expect([state.chaser, state.target]).toEqual(['bob', 'ann']);
    pick(state, 'chaser', 'ann');
    expect([state.chaser, state.target]).toEqual(['ann', 'bob']);
    pick(state, 'target', 'cy');
    expect([state.chaser, state.target]).toEqual(['ann', 'cy']);
  });

  it('says what the chaser needs until both are set, then who finishes ahead', () => {
    const state = createState(BASE, 'scenarios');
    expect(scenarioModel(state, recompute(state)).verdict).toBe(
      'BOB needs +20 on ANN over the rounds left: best case 120, ANN’s floor 90.',
    );
    setEdit(state, edit({}));
    setEdit(state, edit({ entrantKey: 'ann', position: 4, points: 20 }));
    expect(scenarioModel(state, recompute(state)).verdict).toBe('BOB finishes ahead of ANN by 10 (120 to 110).');
    setEdit(state, edit({ position: 5, points: 10 }));
    expect(scenarioModel(state, recompute(state)).verdict).toBe('ANN stays ahead by 30 (110 to 80).');
  });

  it('shows the one-entrant message and no pickers when the championship has one entrant', () => {
    const solo = season(BASE.rounds, [entrant('ann', [50, 40, null, null])]);
    const state = createState(solo, 'scenarios');
    const model = scenarioModel(state, recompute(state));
    expect(model).toMatchObject({ single: true, chaser: null, target: null });
    expect(model.verdict).toBe('Only one entrant in this championship, so there is no one to compare.');
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
  const teams = season([round(1, 'completed'), round(2, 'future')], [team, entrant('t2', [80, null], { members: [] })], {
    isTeam: true,
    championship: 'alpha_team',
  });

  it('re-picks the two counting drivers and the total as a draft changes, and Apply sets the team cell', () => {
    const state = createState(teams, 'contenders');
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
    expect(teamLines(state, snapshot, team, r1, new Map([['m3', { typed: true, choice: 'p1', text: 'x' }]])).valid).toBe(false);

    setEdit(state, draftEdit(r1, drafts.get('m3')!, { entrantKey: 't1', memberKey: 'm3' })!);
    const applied = recompute(state);
    expect(applied.rows.find((r) => r.key === 't1')!.countedTotal).toBe(100);
    expect(teamLines(state, applied, team, r1, new Map()).lines[2]).toMatchObject({ edited: true, counts: true });
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
      round(i + 1, i < 8 ? 'completed' : 'future', { races: 2, tables: [TABLE, TABLE], bestCase: 120, secondPlaceCase: 110 }),
    );
    const entrants = Array.from({ length: 60 }, (_, d) =>
      entrant(`d${d + 1}`, rounds.map((r) => (r.state === 'completed' && next() > 0.1 ? Math.floor(next() * 110) : null))),
    );
    const s = season(rounds, entrants, { dropCount: 2, dropsFromRounds: 5 });
    const state = createState(s, 'contenders');
    recompute(state); // warm-up, as the page does on load
    setEdit(state, edit({ entrantKey: 'd30', roundIndex: 10, position: 1, points: 100 }));
    const start = performance.now();
    const snapshot = recompute(state);
    barViews(snapshot);
    matrixRows(state, snapshot);
    const ms = performance.now() - start;
    expect(snapshot.rows).toHaveLength(60);
    expect(ms).toBeLessThan(100);
  });
});

// --- Markup, into a small fake document -------------------------------------------------------------------

class FakeNode {
  children: FakeNode[] = [];
  attributes = new Map<string, string>();
  constructor(
    public tagName: string,
    public text = '',
  ) {}
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  append(...nodes: FakeNode[]) {
    this.children.push(...nodes);
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  all(predicate: (n: FakeNode) => boolean): FakeNode[] {
    return [...(predicate(this) ? [this] : []), ...this.children.flatMap((c) => c.all(predicate))];
  }
}

describe('the results matrix markup', () => {
  beforeAll(() => {
    vi.stubGlobal('document', {
      createElement: (tag: string) => new FakeNode(tag.toUpperCase()),
      createTextNode: (text: string) => new FakeNode('#text', text),
    });
  });
  afterAll(() => vi.unstubAllGlobals());

  it('makes every cell a labelled button, the special round disabled, with a caption naming the championship', async () => {
    const { matrixElement } = await import('../../src/scripts/pointsCalculatorView');
    const state = createState(BASE, 'contenders');
    setEdit(state, edit({}));
    const root = matrixElement(BASE, matrixRows(state, recompute(state)), 'Overall championship') as unknown as FakeNode;
    const buttons = root.all((n) => n.tagName === 'BUTTON');
    expect(buttons).toHaveLength(12);
    const bob4 = buttons.find((b) => b.getAttribute('data-cell-entrant') === 'bob' && b.getAttribute('data-cell-round') === '4')!;
    expect(bob4.getAttribute('aria-label')).toBe('BOB, round 4: 50 points, edited');
    expect(bob4.getAttribute('data-edited')).toBe('true');
    const special = buttons.filter((b) => b.getAttribute('data-cell-round') === '3');
    expect(special.every((b) => b.getAttribute('disabled') === '' && b.getAttribute('title') === 'No points table for this format')).toBe(true);
    expect(root.all((n) => n.tagName === 'CAPTION')[0].textContent).toBe('Overall championship');
    // Names are text nodes, never markup.
    expect(root.all((n) => n.tagName === 'TH' && n.getAttribute('scope') === 'row').map((n) => n.textContent)).toEqual([
      'BOB',
      'ANN',
      'CY',
    ]);
  });
});
