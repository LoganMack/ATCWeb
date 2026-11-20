/**
 * The Series iRating table (src/scripts/seriesRatings.ts, src/lib/rating/trend.ts, the ratings fragment; FR7.2,
 * FR8.3, NFR6): header sorting and its direction, the name search and its empty state, the result count, the
 * trend line's direction and label, that a hidden driver's row is never a link, each row's history toggle and
 * request, and the history chart (src/scripts/ratingHistoryChart.ts) with its keyboard steps and text
 * equivalent, drawn into a small fake document (tests/scripts/fakeDom.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  historyUrl,
  isRatingSortKey,
  matchesSearch,
  nextSort,
  parseHistory,
  resultCountText,
  sortEntries,
  type RatingEntry,
} from '../../src/scripts/seriesRatings';
import {
  chartGeometry,
  historySummary,
  nearestIndex,
  pointLines,
  positionLabel,
  raceLabel,
  renderHistoryChart,
} from '../../src/scripts/ratingHistoryChart';
import type { RatingHistoryPoint } from '../../src/lib/db/seriesRatings';
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
    expect(trendLine([])).toEqual({ points: '', direction: 'flat', label: 'No rated races yet' });
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
});

const POINTS: RatingHistoryPoint[] = [
  { d: '2026-01-10', s: 'ATC17', t: 'Spa', r: 0, p: 3, f: 12, v: 1400 },
  { d: '2026-01-17', s: 'ATC17', t: 'Monza', r: 2, p: 1, f: 10, v: 1480 },
  { d: '2026-04-04', s: 'ATC18', t: 'Imola', r: 0, p: 7, f: 14, v: 1455 },
];

describe('the history chart', () => {
  it('spaces races evenly, draws higher ratings higher, and marks each new season', () => {
    const geo = chartGeometry(POINTS, 720);
    expect(geo.xs[1] - geo.xs[0]).toBeCloseTo(geo.xs[2] - geo.xs[1], 5);
    expect(geo.ys[1]).toBeLessThan(geo.ys[0]);
    expect(geo.path.startsWith('M')).toBe(true);
    expect(geo.path.split(' L')).toHaveLength(3);
    expect(geo.seasons).toEqual([{ x: geo.xs[2], name: 'ATC18' }]);
    // Gridlines cover every value.
    const values = geo.ticks.map((t) => t.value);
    expect(Math.min(...values)).toBeLessThanOrEqual(1400);
    expect(Math.max(...values)).toBeGreaterThanOrEqual(1480);
    expect(nearestIndex(geo.xs, geo.xs[2] - 1)).toBe(2);
  });

  it('names the race, the position used and the rating after', () => {
    expect(raceLabel(POINTS[0])).toBe('ATC17 · Spa · 10 Jan 2026');
    expect(raceLabel(POINTS[1])).toBe('ATC17 · Monza · Race 2 · 17 Jan 2026');
    expect(positionLabel(POINTS[0], 'Overall')).toBe('P3 of 12 overall');
    expect(positionLabel(POINTS[2], 'Alpha')).toBe('P7 of 14 in Alpha');
    expect(pointLines(POINTS[1], 'Overall')).toEqual([
      'ATC17 · Monza · Race 2 · 17 Jan 2026',
      'P1 of 10 overall · Rating 1480',
    ]);
    expect(historySummary(POINTS, 'Abe', 'Overall')).toBe(
      'Abe’s Overall rating over 3 rated races, 10 Jan 2026 to 4 Apr 2026: now 1455, highest 1480, lowest 1400.',
    );
  });

  describe('in a page', () => {
    let doc: FakeDocument;
    beforeEach(() => {
      doc = installFakeDom();
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('draws the line, a text summary and a hidden table, and steps through races by keyboard', () => {
      const container = doc.createElement('div');
      container.clientWidth = 800;
      doc.body.append(container);
      renderHistoryChart(container as never, POINTS, { name: 'Abe', kindLabel: 'Overall' });

      const summary = container.querySelector('[data-chart-summary]')!;
      expect(summary.textContent).toContain('3 rated races');
      const plot = container.querySelector('[data-chart-plot]')!;
      expect(plot.getAttribute('tabindex')).toBe('0');
      expect(plot.getAttribute('aria-describedby')).toBe(summary.getAttribute('id'));
      expect(container.querySelectorAll('path')).toHaveLength(1);
      expect(container.querySelector('path')!.classes).toContain('text-brand-blue');
      const rows = container.querySelectorAll('table tbody tr');
      expect(rows.map((r) => r.children.map((c) => c.textContent))).toEqual([
        ['ATC17 · Spa · 10 Jan 2026', 'P3 of 12 overall', '1400'],
        ['ATC17 · Monza · Race 2 · 17 Jan 2026', 'P1 of 10 overall', '1480'],
        ['ATC18 · Imola · 4 Apr 2026', 'P7 of 14 overall', '1455'],
      ]);

      // Focus shows the latest race; arrows, Home and End move along and announce each one.
      const status = container.querySelector('[data-chart-status]')!;
      const tip = container.querySelector('[data-chart-tip]')!;
      plot.focus();
      expect(tip.classes).not.toContain('hidden');
      expect(status.textContent).toBe('ATC18 · Imola · 4 Apr 2026. P7 of 14 overall · Rating 1455');
      const left = plot.dispatch('keydown', { key: 'ArrowLeft' });
      expect(left.defaultPrevented).toBe(true);
      expect(status.textContent).toContain('Monza');
      plot.dispatch('keydown', { key: 'Home' });
      expect(status.textContent).toContain('Spa');
      plot.dispatch('keydown', { key: 'ArrowLeft' });
      expect(status.textContent).toContain('Spa');
      plot.dispatch('keydown', { key: 'End' });
      expect(status.textContent).toContain('Imola');
      expect(plot.dispatch('keydown', { key: 'a' }).defaultPrevented).toBe(false);
      plot.dispatch('blur');
      expect(tip.classes).toContain('hidden');
    });

    /** A two-row ratings table as the fragment renders it, plus the shell's search box. */
    function ratingsPage() {
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
      expect(detail.querySelector('[data-chart-summary]')!.textContent).toContain('Abe’s Alpha rating');

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

    it('says so in words when a driver has no races yet', () => {
      const container = doc.createElement('div');
      renderHistoryChart(container as never, [], { name: 'Abe', kindLabel: 'Alpha' });
      expect(container.children).toHaveLength(1);
      expect(container.textContent).toBe('Abe has no rated races in Alpha yet.');
    });
  });
});
