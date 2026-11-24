/**
 * The Series iRating history chart (src/scripts/ratingHistoryChart.ts; U2 NFR7.4, NFR7.5): placing races on
 * the shared round timeline, the stale-cache fallback, the geometry (slots, offsets, up and down runs, the
 * single-race dot, season marks) on a fixed round list, and the chart drawn into the fake document: one path
 * per run, no summary sentence, the plot's label, the hidden table and keyboard stepping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chartGeometry,
  legacyPlacement,
  nearestIndex,
  placeOnTimeline,
  pointLines,
  positionLabel,
  raceLabel,
  renderHistoryChart,
  type ChartPoint,
} from '../../src/scripts/ratingHistoryChart';
import type { TimelineSlot } from '../../src/lib/rating/timeline';
import { installFakeDom, type FakeDocument } from './fakeDom';

/** The worked example's five slots (functional-spec.md); round 150 is an exhibition, so it has none. */
const FIXED_SLOTS: TimelineSlot[] = [
  { i: 101, s: 'ATC1' },
  { i: 102, s: 'ATC1' },
  { i: 201, s: 'ATC2' },
  { i: 202, s: 'ATC2' },
  { i: 301, s: 'ATC3' },
];

const SEASON_OF: Record<number, string> = {
  101: 'ATC1',
  102: 'ATC1',
  150: 'ATC1',
  201: 'ATC2',
  202: 'ATC2',
  301: 'ATC3',
};

function pt(v: number, i: number, r = 0, n = 1, over: Partial<ChartPoint> = {}): ChartPoint {
  return { d: '2026-01-10', s: SEASON_OF[i] ?? 'ATC9', t: 'Spa', r, p: 3, f: 12, v, i, n, ...over };
}

/** x of a point at slot k with offset o, at width 690 over five slots (plotW 632). */
const slotX = (k: number, o: number, slots = 5, width = 690) => 44 + ((k + o) / slots) * (width - 58);

describe('the chart geometry on the shared timeline', () => {
  it('places the worked example: slots, offsets, a skipped exhibition race, runs and season marks', () => {
    const placement = placeOnTimeline(
      [pt(1500, 102), pt(1530, 150), pt(1530, 301, 1, 3), pt(1510, 301, 2, 3)],
      FIXED_SLOTS,
    );
    expect(placement.slotCount).toBe(5);
    expect(placement.placed.map((p) => p.point.i)).toEqual([102, 301, 301]);
    const geo = chartGeometry(placement, 690);
    expect(geo.xs).toHaveLength(3);
    expect(geo.xs[0]).toBeCloseTo(233.6, 1);
    expect(geo.xs[1]).toBeCloseTo(570.7, 1);
    expect(geo.xs[2]).toBeCloseTo(612.8, 1);
    expect(geo.runs.map((r) => r.direction)).toEqual(['up', 'down']);
    expect(geo.dot).toBeNull();
    expect(geo.seasons.map((s) => s.name)).toEqual(['ATC1', 'ATC2', 'ATC3']);
    expect(geo.seasons[0].x).toBeCloseTo(44, 1);
    expect(geo.seasons[1].x).toBeCloseTo(296.8, 1);
    expect(geo.seasons[2].x).toBeCloseTo(549.6, 1);
    expect(geo.seasons.map((s) => s.labelled)).toEqual([true, true, true]);
    expect(geo.seasons.map((s) => s.first)).toEqual([true, false, false]);
    // Higher ratings are drawn higher, and gridlines cover every value.
    expect(geo.ys[1]).toBeLessThan(geo.ys[0]);
    const values = geo.ticks.map((t) => t.value);
    expect(Math.min(...values)).toBeLessThanOrEqual(1500);
    expect(Math.max(...values)).toBeGreaterThanOrEqual(1530);
    expect(nearestIndex(geo.xs, geo.xs[2] - 1)).toBe(2);
  });

  it('gives two drivers who started in different seasons the same slots and season marks (AC1.3.1, AC1.3.6)', () => {
    const early = chartGeometry(placeOnTimeline([pt(1400, 101), pt(1420, 202)], FIXED_SLOTS), 690);
    const late = chartGeometry(placeOnTimeline([pt(1500, 301, 1, 2), pt(1490, 301, 2, 2)], FIXED_SLOTS), 690);
    expect(placeOnTimeline([pt(1500, 301)], FIXED_SLOTS).slotCount).toBe(5);
    expect(late.seasons).toEqual(early.seasons);
  });

  it('runs one straight line across rounds the driver missed (AC1.3.2)', () => {
    const geo = chartGeometry(placeOnTimeline([pt(1400, 101), pt(1450, 202)], FIXED_SLOTS), 690);
    expect(geo.runs).toHaveLength(1);
    const segments = geo.runs[0].d.split(' L');
    expect(segments).toHaveLength(2);
    expect(geo.xs[0]).toBeCloseTo(slotX(0, 0.5), 5);
    expect(geo.xs[1]).toBeCloseTo(slotX(3, 0.5), 5);
  });

  it('spreads a three-race round evenly inside its slot, and centres a one-race round (AC1.3.3)', () => {
    const three = placeOnTimeline([pt(1, 201, 1, 3), pt(2, 201, 2, 3), pt(3, 201, 3, 3)], FIXED_SLOTS);
    expect(three.placed.map((p) => p.offset)).toEqual([1 / 6, 3 / 6, 5 / 6]);
    expect(three.placed.every((p) => p.slot === 2)).toBe(true);
    expect(placeOnTimeline([pt(1, 202, 0, 1)], FIXED_SLOTS).placed[0]).toMatchObject({
      slot: 3,
      offset: 0.5,
    });
  });

  it('skips a race whose round has no slot and joins its neighbours (AC1.3.4)', () => {
    const geo = chartGeometry(
      placeOnTimeline([pt(1400, 101), pt(1600, 150), pt(1450, 201)], FIXED_SLOTS),
      690,
    );
    expect(geo.xs).toHaveLength(2);
    expect(geo.runs).toEqual([
      { direction: 'up', d: expect.stringMatching(/^M[\d.]+,[\d.]+ L[\d.]+,[\d.]+$/) },
    ]);
  });

  it('drops a season name that would crowd the previous one, keeping its mark (AC1.3.5)', () => {
    const slots = Array.from({ length: 10 }, (_, k) => ({ i: k + 1, s: `S${k + 1}` }));
    const geo = chartGeometry(placeOnTimeline([pt(1400, 1), pt(1410, 10)], slots), 320);
    // Slots are 26.2 px wide here: S2 and S3 start under 56 px after S1, S4 does not.
    expect(geo.seasons).toHaveLength(10);
    expect(geo.seasons.slice(0, 4).map((s) => s.labelled)).toEqual([true, false, false, true]);
    expect(geo.seasons[1].first).toBe(false);

    const unnamed = chartGeometry(
      placeOnTimeline(
        [pt(1400, 1)],
        [
          { i: 1, s: 'A' },
          { i: 2, s: '' },
          { i: 3, s: 'C' },
        ],
      ),
      690,
    );
    expect(unnamed.seasons.map((s) => [s.name, s.labelled])).toEqual([
      ['A', true],
      ['', false],
      ['C', true],
    ]);
  });

  it('drops a season name that would run into a long name before it, keeping its mark (AC1.3.5)', () => {
    // Slots are 72 px apart at width 202 over 2 slots (plotW 144). "ATC4 Off-Season Fun Series" is 26
    // characters, about 156 px estimated, so ATC7 at 116 px would be drawn over it.
    const long = [
      { i: 1, s: 'ATC4 Off-Season Fun Series' },
      { i: 2, s: 'ATC7' },
    ];
    const crowded = chartGeometry(placeOnTimeline([pt(1400, 1), pt(1410, 2)], long), 202);
    expect(crowded.seasons.map((s) => [s.name, s.labelled])).toEqual([
      ['ATC4 Off-Season Fun Series', true],
      ['ATC7', false],
    ]);
    expect(crowded.seasons[1].x).toBeCloseTo(116, 5);

    // The same names far enough apart (slots of 240 px) are both labelled.
    const roomy = chartGeometry(placeOnTimeline([pt(1400, 1), pt(1410, 2)], long), 538);
    expect(roomy.seasons.map((s) => s.labelled)).toEqual([true, true]);

    // A long name in the middle crowds out only the next label, not the one after it.
    const middle = chartGeometry(
      placeOnTimeline(
        [pt(1400, 1), pt(1410, 4)],
        [
          { i: 1, s: 'ATC3' },
          { i: 2, s: 'ATC4 Off-Season Fun Series' },
          { i: 3, s: 'ATC7' },
          { i: 4, s: 'ATC9' },
        ],
      ),
      690,
    );
    expect(middle.seasons.map((s) => s.labelled)).toEqual([true, true, false, true]);
  });

  it('keeps short season names 56 px or more apart (AC1.3.5)', () => {
    const slots = [
      { i: 1, s: 'ATC1' },
      { i: 2, s: 'ATC2' },
    ];
    // Slots are 56 px apart at width 170 over 2 slots (plotW 112).
    const geo = chartGeometry(placeOnTimeline([pt(1400, 1), pt(1410, 2)], slots), 170);
    expect(geo.seasons[1].x - geo.seasons[0].x).toBeCloseTo(56, 5);
    expect(geo.seasons.map((s) => s.labelled)).toEqual([true, true]);
  });

  it('draws one race as a dot with no runs (AC1.1.4)', () => {
    const geo = chartGeometry(placeOnTimeline([pt(1400, 202)], FIXED_SLOTS), 690);
    expect(geo.runs).toEqual([]);
    expect(geo.dot).toEqual({ x: geo.xs[0], y: geo.ys[0] });
  });

  it('falls back to even spacing for no slot list, or points without i or n (BR1.13)', () => {
    const points: ChartPoint[] = [
      { d: '2026-01-10', s: 'ATC17', t: 'Spa', r: 0, p: 3, f: 12, v: 1400 },
      { d: '2026-01-17', s: 'ATC17', t: 'Monza', r: 2, p: 1, f: 10, v: 1480 },
      { d: '2026-04-04', s: 'ATC18', t: 'Imola', r: 0, p: 7, f: 14, v: 1455 },
    ];
    const legacy = legacyPlacement(points);
    expect(legacy.slotCount).toBe(3);
    expect(legacy.placed.map((p) => [p.slot, p.offset])).toEqual([
      [0, 0.5],
      [1, 0.5],
      [2, 0.5],
    ]);
    expect(legacy.marks).toEqual([
      { slot: 0, label: 'ATC17' },
      { slot: 2, label: 'ATC18' },
    ]);
    expect(placeOnTimeline(points, FIXED_SLOTS)).toEqual(legacy);
    const withI = points.map((p, k) => ({ ...p, i: FIXED_SLOTS[k].i }));
    expect(placeOnTimeline(withI, FIXED_SLOTS).slotCount).toBe(3); // n missing: legacy
    const full = withI.map((p) => ({ ...p, n: 1 }));
    expect(placeOnTimeline(full, null).slotCount).toBe(3);
    expect(placeOnTimeline(full, FIXED_SLOTS).slotCount).toBe(5);
    const geo = chartGeometry(legacy, 690);
    expect(geo.xs[1] - geo.xs[0]).toBeCloseTo(geo.xs[2] - geo.xs[1], 5);
  });

  it('clamps a race number above the round’s count to the last position in the slot', () => {
    expect(placeOnTimeline([pt(1, 201, 5, 3)], FIXED_SLOTS).placed[0].offset).toBeCloseTo(5 / 6, 10);
  });

  it('skips a race newer than a cached slot list and draws the rest (NFR2.2)', () => {
    const geo = chartGeometry(
      placeOnTimeline([pt(1400, 101), pt(1420, 202), pt(1430, 999)], FIXED_SLOTS),
      690,
    );
    expect(geo.xs).toHaveLength(2);
    expect(geo.runs).toHaveLength(1);
  });

  it('skips a scored round with no slot, so the next segment shows the net change (rated round gap)', () => {
    // 1450 at an unlinked round 777 is skipped; 1400 -> 1420 draws as one rising segment.
    const placement = placeOnTimeline([pt(1400, 101), pt(1450, 777), pt(1420, 102)], FIXED_SLOTS);
    expect(placement.placed.map((p) => p.point.v)).toEqual([1400, 1420]);
    expect(chartGeometry(placement, 690).runs.map((r) => r.direction)).toEqual(['up']);
  });
});

describe('the chart labels', () => {
  const p: ChartPoint = { d: '2026-01-17', s: 'ATC17', t: 'Monza', r: 2, p: 1, f: 10, v: 1480 };
  it('names the race, the position used and the rating after', () => {
    expect(raceLabel({ ...p, r: 0, t: 'Spa', d: '2026-01-10' })).toBe('ATC17 · Spa · 10 Jan 2026');
    expect(raceLabel(p)).toBe('ATC17 · Monza · Race 2 · 17 Jan 2026');
    expect(positionLabel({ ...p, p: 7, f: 14 }, 'Alpha')).toBe('P7 of 14 in Alpha');
    expect(pointLines(p, 'Overall')).toEqual([
      'ATC17 · Monza · Race 2 · 17 Jan 2026',
      'P1 of 10 overall · Rating 1480',
    ]);
  });
});

describe('the chart in a page', () => {
  let doc: FakeDocument;
  beforeEach(() => {
    doc = installFakeDom();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const POINTS: ChartPoint[] = [
    pt(1400, 101, 0, 1, { s: 'ATC1', t: 'Spa', d: '2026-01-10' }),
    pt(1480, 201, 2, 2, { s: 'ATC2', t: 'Monza', d: '2026-01-17', p: 1, f: 10 }),
    pt(1600, 150, 0, 1, { s: 'ATC1', t: 'Exhibition', d: '2026-02-01' }),
    pt(1455, 301, 0, 1, { s: 'ATC3', t: 'Imola', d: '2026-04-04', p: 7, f: 14 }),
  ];

  function draw(points: readonly ChartPoint[], timeline: TimelineSlot[] | null = FIXED_SLOTS) {
    const container = doc.createElement('div');
    container.clientWidth = 800;
    doc.body.append(container);
    renderHistoryChart(container as never, points, { name: 'Abe', kindLabel: 'Overall', timeline });
    return container;
  }

  it('draws one coloured path per run, and no summary sentence (AC1.2.2)', () => {
    const container = draw(POINTS);
    const paths = container.querySelectorAll('path[data-dir]');
    expect(paths.map((p) => p.getAttribute('data-dir'))).toEqual(['up', 'down']);
    expect(paths[0].classes).toContain('text-brand-blue');
    expect(paths[1].classes).toContain('text-brand-pink');
    expect(container.querySelector('circle[data-chart-dot]')).toBeNull();
    expect(container.querySelector('p[data-chart-summary]')).toBeNull();
    expect(container.textContent).not.toMatch(/rating over \d+ rated races/);
  });

  it('draws one race as a dot, with no summary sentence (AC1.1.4, AC1.2.1)', () => {
    const container = draw([POINTS[0]]);
    expect(container.querySelectorAll('path[data-dir]')).toHaveLength(0);
    const dot = container.querySelector('circle[data-chart-dot]')!;
    expect(dot.classes).toContain('text-brand-blue');
    expect(container.querySelector('p[data-chart-summary]')).toBeNull();
    expect(container.textContent).not.toMatch(/rating over \d+ rated race/);
    expect(container.querySelector('[data-chart-plot]')!.getAttribute('aria-label')).toBe(
      'Abe’s Overall rating chart, 1400 after 1 rated race. Use the left and right arrow keys to step through the races.',
    );
  });

  it('labels the plot with the first and last rating and the drawn race count', () => {
    const plot = draw(POINTS).querySelector('[data-chart-plot]')!;
    expect(plot.getAttribute('aria-label')).toBe(
      'Abe’s Overall rating chart, from 1400 to 1455 over 3 rated races. Use the left and right arrow keys to step through the races.',
    );
    expect(plot.getAttribute('role')).toBe('group');
    expect(plot.getAttribute('tabindex')).toBe('0');
    expect(plot.hasAttribute('aria-describedby')).toBe(false);
  });

  it('lists every drawn race in the hidden table and none that was skipped (AC1.1.5)', () => {
    const rows = draw(POINTS).querySelectorAll('table tbody tr');
    expect(rows.map((r) => r.children.map((c) => c.textContent))).toEqual([
      ['ATC1 · Spa · 10 Jan 2026', 'P3 of 12 overall', '1400'],
      ['ATC2 · Monza · Race 2 · 17 Jan 2026', 'P1 of 10 overall', '1480'],
      ['ATC3 · Imola · 4 Apr 2026', 'P7 of 14 overall', '1455'],
    ]);
  });

  it('steps through the drawn races by keyboard and announces each one', () => {
    const container = draw(POINTS);
    const plot = container.querySelector('[data-chart-plot]')!;
    const status = container.querySelector('[data-chart-status]')!;
    const tip = container.querySelector('[data-chart-tip]')!;
    plot.focus();
    expect(tip.classes).not.toContain('hidden');
    expect(status.textContent).toBe('ATC3 · Imola · 4 Apr 2026. P7 of 14 overall · Rating 1455');
    const left = plot.dispatch('keydown', { key: 'ArrowLeft' });
    expect(left.defaultPrevented).toBe(true);
    expect(status.textContent).toBe('ATC2 · Monza · Race 2 · 17 Jan 2026. P1 of 10 overall · Rating 1480');
    plot.dispatch('keydown', { key: 'Home' });
    expect(status.textContent).toContain('Spa');
    plot.dispatch('keydown', { key: 'ArrowLeft' });
    expect(status.textContent).toContain('Spa');
    plot.dispatch('keydown', { key: 'ArrowRight' });
    expect(status.textContent).toContain('Monza');
    plot.dispatch('keydown', { key: 'End' });
    expect(status.textContent).toContain('Imola');
    expect(plot.dispatch('keydown', { key: 'a' }).defaultPrevented).toBe(false);
    plot.dispatch('blur');
    expect(tip.classes).toContain('hidden');
  });

  it('says so in words, with no chart, when every race is skipped or there are none', () => {
    const cases: [ReturnType<typeof pt>[], string][] = [
      [[pt(1400, 150)], "Abe's rated races in Overall are not on the chart timeline yet."],
      [[], 'Abe has no rated races in Overall yet.'],
    ];
    for (const [points, message] of cases) {
      const container = draw(points);
      expect(container.children).toHaveLength(1);
      expect(container.querySelector('p[data-chart-empty]')).not.toBeNull();
      expect(container.querySelector('svg')).toBeNull();
      expect(container.textContent).toBe(message);
    }
  });
});
