/**
 * The Series iRating table (src/scripts/seriesRatings.ts, src/lib/rating/trend.ts, the ratings fragment; FR7.2,
 * FR8.3, NFR6): header sorting and its direction, the name search and its empty state, the result count, the
 * trend line's direction, label and up and down runs, that a hidden driver's row is never a link, the parsing
 * of the history and the fragment's slot list, and each row's history toggle and request, which hands the slot
 * list to the chart, in a small fake document (tests/scripts/fakeDom.ts). The chart itself is covered in
 * tests/scripts/ratingHistoryChart.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  historyUrl,
  isRatingSortKey,
  matchesSearch,
  nextSort,
  parseHistory,
  parseTimeline,
  resultCountText,
  sortEntries,
  type RatingEntry,
} from '../../src/scripts/seriesRatings';
import type { RatingHistoryPoint } from '../../src/lib/db/seriesRatings';
import type { TimelineSlot } from '../../src/lib/rating/timeline';
import { TREND_HEIGHT, TREND_WIDTH, trendLine } from '../../src/lib/rating/trend';
import { installFakeDom, type FakeDocument } from './fakeDom';

// Bundled by Vite's glob import, as the structure tests read page sources.
const FRAGMENT = (
  import.meta.glob('/src/pages/advanced-stats/ratings/fragment.astro', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>
)['/src/pages/advanced-stats/ratings/fragment.astro'];

const entry = (rank: number, name: string, current: number, races: number, last = 0): RatingEntry => ({
  rank,
  name,
  current,
  last,
  min: current - 100,
  max: current + 100,
  races,
});

const ROWS = [
  entry(1, 'Cara', 2100, 40, 12),
  entry(2, 'Hidden Driver', 1900, 3, -20),
  entry(3, 'Abe', 1900, 12, 5),
];

describe('sorting', () => {
  it('starts high-first on a number column, A-Z on the name, and flips on a second click', () => {
    const start = { key: 'current' as const, direction: 'descending' as const };
    expect(nextSort(start, 'current')).toEqual({ key: 'current', direction: 'ascending' });
    expect(nextSort(start, 'races')).toEqual({ key: 'races', direction: 'descending' });
    expect(nextSort(start, 'name')).toEqual({ key: 'name', direction: 'ascending' });
    expect(isRatingSortKey('last')).toBe(true);
    expect(isRatingSortKey('trend')).toBe(false);
  });

  it('sorts by the chosen column and keeps the default order for ties', () => {
    expect(sortEntries(ROWS, 'current', 'ascending').map((e) => e.name)).toEqual([
      'Hidden Driver',
      'Abe',
      'Cara',
    ]);
    expect(sortEntries(ROWS, 'name', 'ascending').map((e) => e.name)).toEqual([
      'Abe',
      'Cara',
      'Hidden Driver',
    ]);
    expect(sortEntries(ROWS, 'last', 'descending').map((e) => e.rank)).toEqual([1, 3, 2]);
    expect(sortEntries(ROWS, 'races', 'ascending').map((e) => e.races)).toEqual([3, 12, 40]);
  });
});

describe('search', () => {
  it('matches part of the shown name in any case; a hidden driver only as "Hidden Driver"', () => {
    expect(ROWS.filter((e) => matchesSearch(e.name, 'ab')).map((e) => e.name)).toEqual(['Abe']);
    expect(ROWS.filter((e) => matchesSearch(e.name, 'hidden')).map((e) => e.rank)).toEqual([2]);
    expect(ROWS.filter((e) => matchesSearch(e.name, '  ')).length).toBe(3);
    expect(ROWS.filter((e) => matchesSearch(e.name, 'zed')).length).toBe(0);
  });

  it('announces the count, and the fragment carries the no-match state with Clear search (FR8.3)', () => {
    expect(resultCountText(3, 3)).toBe('3 drivers');
    expect(resultCountText(1, 3)).toBe('1 of 3 drivers match');
    expect(resultCountText(0, 3)).toBe('0 of 3 drivers match');
    expect(FRAGMENT).toContain('data-rating-no-match');
    expect(FRAGMENT).toMatch(
      /<button type="button" class="btn btn-sm ml-2" data-rating-clear>Clear search<\/button>/,
    );
    expect(FRAGMENT).toContain('No driver has {MIN_RATED_RACES} rated races in this class yet.');
  });
});

describe('the trend line', () => {
  it('is blue when the shown run ends higher and pink when lower, with a spoken label', () => {
    expect(trendLine([5202, 5180, 5124])).toMatchObject({
      direction: 'down',
      label: 'Falling over last 3 races, 5202 to 5124',
    });
    expect(trendLine([1350, 1416.4])).toMatchObject({
      direction: 'up',
      label: 'Rising over last 2 races, 1350 to 1416',
    });
    expect(trendLine([1400])).toMatchObject({ direction: 'flat', label: 'Level over 1 race, 1400 to 1400' });
  });

  it('colours each run by its own direction while the word describes the window (AC1.1.2)', () => {
    const trend = trendLine([1400, 1450, 1500, 1460, 1440, 1520]);
    expect(trend.direction).toBe('up');
    expect(trend.label).toBe('Rising over last 6 races, 1400 to 1520');
    expect(trend.runs.map((r) => r.direction)).toEqual(['up', 'down', 'up']);
    expect(trend.dot).toBeNull();
    // Each run starts where the previous one ended, so the line is unbroken.
    const runs = trend.runs.map((r) => r.points.split(' '));
    expect(runs.map((r) => r.length)).toEqual([3, 3, 2]);
    expect(runs[1][0]).toBe(runs[0][runs[0].length - 1]);
    expect(runs[2][0]).toBe(runs[1][runs[1].length - 1]);
  });

  it('draws a dot for one value and nothing for none (BR1.4)', () => {
    expect(trendLine([1400])).toMatchObject({ runs: [], dot: { x: 40, y: 10 } });
    expect(trendLine([])).toEqual({
      points: '',
      direction: 'flat',
      label: 'No rated races yet',
      runs: [],
      dot: null,
    });
  });

  it('keeps the runs to the last 20 values inside the 80×20 box', () => {
    const values = Array.from({ length: 25 }, (_, i) => (i % 2 === 0 ? 1000 + i * 10 : 990 + i * 10));
    const { runs } = trendLine(values);
    const coords = runs.flatMap((r) => r.points.split(' ')).map((p) => p.split(',').map(Number));
    // 19 segments drawn: 20 points plus one shared point per run boundary.
    expect(coords).toHaveLength(20 + runs.length - 1);
    for (const [x, y] of coords) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(TREND_WIDTH);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(TREND_HEIGHT);
    }
  });

  it('draws at most the last 20 values inside the 80×20 box', () => {
    const values = Array.from({ length: 30 }, (_, i) => 1000 + i * 10);
    const { points, label } = trendLine(values);
    const coords = points.split(' ').map((p) => p.split(',').map(Number));
    expect(coords).toHaveLength(20);
    expect(label).toBe('Rising over last 20 races, 1100 to 1290');
    for (const [x, y] of coords) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(TREND_WIDTH);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(TREND_HEIGHT);
    }
    // Higher ratings are drawn higher (smaller y).
    expect(coords[19][1]).toBeLessThan(coords[0][1]);
  });
});

describe('the ratings fragment', () => {
  it('links only rows with a driver id, so a hidden driver is plain text (FR7.4)', () => {
    expect(FRAGMENT).toMatch(
      /\{row\.driverId \? <a href=\{`\/drivers\/\$\{row\.driverId\}`\}[^}]*>\{row\.name\}<\/a> : <span>\{row\.name\}<\/span>\}/,
    );
    expect(FRAGMENT).not.toContain('starting_irating');
  });

  it('labels each trend SVG, with no provisional marking, caption or subtitle', () => {
    expect(FRAGMENT).toMatch(/role="img"\s+aria-label=\{trend\.label\}/);
    expect(FRAGMENT).toMatch(/aria-sort=\{h\.key === 'current' \? 'descending' : 'none'\}/);
    expect(FRAGMENT).not.toMatch(/provisional/i);
    expect(FRAGMENT).not.toContain('<caption');
    expect(FRAGMENT).not.toContain('rated on series races only');
    expect(FRAGMENT).toContain('aria-labelledby="series-rating-heading"');
  });

  it('gives each row a toggle for its history row, which is hidden and kept out of the stripes', () => {
    expect(FRAGMENT).toMatch(
      /aria-expanded="false"\s+aria-controls=\{detailId\}\s+aria-label=\{`Rating history for \$\{row\.name\}`\}\s+data-rating-toggle/,
    );
    expect(FRAGMENT).toContain('<tr id={detailId} hidden data-no-stripe data-rating-detail>');
    expect(FRAGMENT).toContain('<div data-rating-chart></div>');
    expect(FRAGMENT).toContain('data-key={row.key}');
    // The name column stays pinned and opaque, so the shared stripe rule paints it too.
    expect(FRAGMENT).toMatch(/<th scope="row" class="sticky left-0 z-10 bg-brand-ink/);
  });

  it('draws a polyline per run coloured by its direction, and a dot for one value (BR1.1, BR1.4)', () => {
    expect(FRAGMENT).toMatch(
      /trend\.runs\.map\(\(run\) => \(\s*<polyline points=\{run\.points\} class=\{run\.direction === 'down' \? 'text-brand-pink' : 'text-brand-blue'\} data-dir=\{run\.direction\}/,
    );
    expect(FRAGMENT).toMatch(
      /\{trend\.dot && <circle cx=\{trend\.dot\.x\} cy=\{trend\.dot\.y\} r="1\.5" class="text-brand-blue" fill="currentColor" \/>\}/,
    );
    // The SVG itself carries no colour, so no line is one colour unless every segment goes one way.
    const svg = /<svg[\s\S]*?data-trend=\{trend\.direction\}\s*>/.exec(FRAGMENT)?.[0] ?? '';
    expect(svg).not.toBe('');
    expect(svg).not.toMatch(/text-brand-|class:list/);
    expect(FRAGMENT).not.toContain('points={trend.points}');
  });

  it('embeds the slot list once, through safeJson, only when there are rows (BR1.7, NFR3.4)', () => {
    const tag =
      '<script type="application/json" id="rating-timeline" data-rating-timeline set:html={safeJson(timeline)} />';
    expect(FRAGMENT.split(tag)).toHaveLength(2);
    const rowsBlock = FRAGMENT.slice(FRAGMENT.indexOf('{rows.length > 0 && ('));
    expect(rowsBlock).toContain(tag);
    expect(FRAGMENT.indexOf(tag)).toBeGreaterThan(FRAGMENT.indexOf('</table>'));
    expect(FRAGMENT.indexOf(tag)).toBeLessThan(FRAGMENT.indexOf('</section>'));
  });
});

describe('the history request', () => {
  it('asks for one class and driver key, leaving Overall without a class', () => {
    expect(historyUrl('Alpha', 'h123')).toBe('/advanced-stats/ratings/history?class=Alpha&driver=h123');
    expect(historyUrl('', '0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(
      '/advanced-stats/ratings/history?driver=0f8fad5b-d9cb-469f-a165-70867728950e',
    );
  });

  it('keeps only well-formed steps and refuses a body with none', () => {
    const good = { d: '2026-04-01', s: 'ATC18', t: 'Spa', r: 0, p: 3, f: 12, v: 1450 };
    expect(parseHistory({ steps: [good, { d: 1 }, null, { ...good, v: 'x' }] })).toEqual([good]);
    expect(parseHistory({ steps: [] })).toEqual([]);
    for (const bad of [null, {}, { steps: 'x' }, 'text']) expect(parseHistory(bad)).toBeNull();
  });

  it('keeps integer i and n (n at least 1) and leaves other values out, keeping the step (BR1.14)', () => {
    const good = { d: '2026-04-01', s: 'ATC18', t: 'Spa', r: 0, p: 3, f: 12, v: 1450 };
    expect(parseHistory({ steps: [{ ...good, i: 102, n: 3 }] })).toEqual([{ ...good, i: 102, n: 3 }]);
    const loose = parseHistory({
      steps: [
        { ...good, i: 1.5, n: 0 },
        { ...good, i: '102', n: null },
      ],
    })!;
    expect(loose).toEqual([good, good]);
    for (const step of loose) {
      expect('i' in step).toBe(false);
      expect('n' in step).toBe(false);
    }
  });
});

const FIXED_SLOTS: TimelineSlot[] = [
  { i: 101, s: 'ATC1' },
  { i: 102, s: 'ATC1' },
  { i: 201, s: 'ATC2' },
  { i: 202, s: 'ATC2' },
  { i: 301, s: 'ATC3' },
];

describe('the slot list', () => {
  it('reads the fragment’s slots and drops extra keys', () => {
    expect(parseTimeline(JSON.stringify(FIXED_SLOTS))).toEqual(FIXED_SLOTS);
    expect(parseTimeline('[{"i":101,"s":"ATC1","x":1}]')).toEqual([{ i: 101, s: 'ATC1' }]);
  });

  it('gives null for a missing, malformed or empty list, so the chart spaces races evenly (BR1.13)', () => {
    for (const bad of [
      null,
      undefined,
      '',
      '{not json',
      '{"i":1,"s":"A"}',
      '[]',
      '[{"i":1.5,"s":"A"}]',
      '[{"i":1,"s":2}]',
      '[null]',
    ]) {
      expect(parseTimeline(bad), String(bad)).toBeNull();
    }
  });
});

const POINTS: RatingHistoryPoint[] = [
  { d: '2026-01-10', s: 'ATC1', t: 'Spa', r: 0, p: 3, f: 12, v: 1400, i: 101, n: 1 },
  { d: '2026-01-17', s: 'ATC2', t: 'Monza', r: 0, p: 1, f: 10, v: 1480, i: 201, n: 1 },
  { d: '2026-04-04', s: 'ATC3', t: 'Imola', r: 0, p: 7, f: 14, v: 1455, i: 301, n: 1 },
];

describe('opening a row', () => {
  describe('in a page', () => {
    let doc: FakeDocument;
    beforeEach(() => {
      doc = installFakeDom();
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** A two-row ratings table as the fragment renders it, plus the shell's search box. */
    function ratingsPage(timeline?: string) {
      const el = (
        tag: string,
        attrs: Record<string, string> = {},
        ...children: ReturnType<typeof doc.createElement>[]
      ) => {
        const node = doc.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
        node.append(...children);
        return node;
      };
      const search = el('input', { 'data-rating-search': '' });
      const tbody = el('tbody');
      for (const [i, name, key] of [
        [1, 'Abe', 'h42'],
        [2, 'Cara', '0f8fad5b-d9cb-469f-a165-70867728950e'],
      ] as const) {
        const toggle = el(
          'button',
          { 'aria-expanded': 'false', 'aria-controls': `rating-history-${i}`, 'data-rating-toggle': '' },
          el('span', { 'data-chevron': '' }),
        );
        tbody.append(
          el(
            'tr',
            {
              'data-rating-row': '',
              'data-key': key,
              'data-rank': String(i),
              'data-name': name,
              'data-current': String(1500 - i),
            },
            el('td', {}, toggle),
          ),
          el(
            'tr',
            { id: `rating-history-${i}`, hidden: '', 'data-no-stripe': '', 'data-rating-detail': '' },
            el('td', {}, el('div', { 'data-rating-chart': '' })),
          ),
        );
      }
      const section = el(
        'section',
        { 'data-series-ratings': '', 'data-rating-class': 'Alpha', 'data-rating-kind-label': 'Alpha' },
        el('div', { 'data-rating-table-wrap': '' }, el('table', { 'data-rating-table': '' }, tbody)),
      );
      if (timeline !== undefined) {
        const script = el('script', {
          type: 'application/json',
          id: 'rating-timeline',
          'data-rating-timeline': '',
        });
        script.textContent = timeline;
        section.append(script);
      }
      doc.body.append(search, el('div', { 'data-ratings-view': '' }, section));
      return { tbody, search };
    }

    it('opens a row’s history on its toggle, fetching it once, and closes it again', async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ steps: POINTS }) }));
      vi.stubGlobal('fetch', fetchMock);
      const { tbody } = ratingsPage();
      vi.resetModules();
      await import('../../src/scripts/seriesRatings');

      const toggle = tbody.querySelectorAll('[data-rating-toggle]')[0];
      const detail = tbody.querySelectorAll('[data-rating-detail]')[0];
      expect(detail.id).toBe(toggle.getAttribute('aria-controls'));
      expect(fetchMock).not.toHaveBeenCalled();
      toggle.click();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(detail.hidden).toBe(false);
      expect(toggle.querySelector('[data-chevron]')!.classes).toContain('rotate-90');
      await vi.waitFor(() => expect(detail.querySelector('[data-chart-plot]')).not.toBeNull());
      expect(fetchMock).toHaveBeenCalledWith(
        '/advanced-stats/ratings/history?class=Alpha&driver=h42',
        expect.anything(),
      );
      expect(detail.querySelector('[data-chart-plot]')!.getAttribute('aria-label')).toContain(
        'Abe’s Alpha rating chart',
      );

      toggle.click();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(detail.hidden).toBe(true);
      toggle.click();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('offers Try again when the history cannot be loaded', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
      );
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { tbody } = ratingsPage();
      vi.resetModules();
      await import('../../src/scripts/seriesRatings');
      tbody.querySelectorAll('[data-rating-toggle]')[1].click();
      const detail = tbody.querySelectorAll('[data-rating-detail]')[1];
      await vi.waitFor(() => expect(detail.textContent).toContain('Try again'));
      expect(detail.querySelector('button')!.classes).toEqual(['btn', 'btn-sm', 'ml-2']);
      error.mockRestore();
    });

    /** Opens the first row and returns the x where its first drawn path starts. */
    async function firstPathX(timeline?: string): Promise<number> {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, json: async () => ({ steps: POINTS }) })),
      );
      const { tbody } = ratingsPage(timeline);
      vi.resetModules();
      await import('../../src/scripts/seriesRatings');
      tbody.querySelectorAll('[data-rating-toggle]')[0].click();
      const detail = tbody.querySelectorAll('[data-rating-detail]')[0];
      await vi.waitFor(() => expect(detail.querySelector('path[data-dir]')).not.toBeNull());
      const d = detail.querySelector('path[data-dir]')!.getAttribute('d')!;
      return Number(/^M([\d.]+),/.exec(d)![1]);
    }

    // The fake container has no width, so the chart draws at 720: a plot 662 px wide from x = 44.
    it('passes the section’s slot list to the chart, so races sit in their round’s slot', async () => {
      expect(await firstPathX(JSON.stringify(FIXED_SLOTS))).toBeCloseTo(44 + (0.5 / 5) * 662, 1);
    });

    it('spaces races evenly when the section carries no slot list', async () => {
      expect(await firstPathX()).toBeCloseTo(44 + (0.5 / 3) * 662, 1);
    });
  });
});
