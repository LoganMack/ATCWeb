/**
 * The Series iRating chart pins (irating-chart U2: BR1.6, BR1.9, BR1.15 to BR1.18; NFR1.2, NFR3.4, NFR4.1,
 * NFR4.2, NFR5.2, NFR7.7): the search box's place in the filter card, the fragment's one request wave and its
 * safeJson slot list, no summary sentence anywhere, no hex colours or innerHTML in the drawing code, and the
 * timeline select's FK hints. A src-only pull request skips the migrations-rebuild embed check, so these pins
 * keep the constraint names and the single encoding from drifting.
 */
import { describe, expect, it } from 'vitest';
import embedReads from '../../src/lib/embedReads.json';
import privacyReads from '../../src/lib/privacyReads.json';
import { ROUND_EVENT_CATEGORY_SELECT } from '../../src/lib/results/roundEligibility';
import SHELL from '../../src/pages/advanced-stats.astro?raw';
import FRAGMENT from '../../src/pages/advanced-stats/ratings/fragment.astro?raw';
import HISTORY from '../../src/pages/advanced-stats/ratings/history.ts?raw';
import SERIES_RATINGS from '../../src/lib/db/seriesRatings.ts?raw';
import CHART from '../../src/scripts/ratingHistoryChart.ts?raw';
import TREND from '../../src/lib/rating/trend.ts?raw';
import SEGMENTS from '../../src/lib/rating/segments.ts?raw';

const SOURCES = import.meta.glob('/src/**/*.{ts,astro}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const MIGRATIONS = import.meta.glob('/supabase/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const BASELINE = MIGRATIONS['/supabase/migrations/20261020120000_baseline_schema.sql'] ?? '';

const SEARCH_CLASS =
  'search-input h-9 rounded-md border border-white/15 bg-transparent px-3 text-sm text-white outline-none hover:bg-white/5 focus:border-brand-primary focus:bg-white/5';

describe('the filter card', () => {
  it('puts the search box right after View and before Class, in the wrapping row (AC1.4.1, AC1.4.2)', () => {
    const search = SHELL.indexOf('data-rating-search');
    expect(search).toBeGreaterThan(-1);
    expect(SHELL.split('data-rating-search')).toHaveLength(2);
    expect(search).toBeGreaterThan(SHELL.lastIndexOf('aria-label="View"'));
    expect(search).toBeLessThan(SHELL.indexOf('aria-label="Class"'));
    // Nothing but the closing View label sits between the View select and the search box.
    const between = SHELL.slice(SHELL.lastIndexOf('aria-label="View"'), search);
    expect(between).toMatch(/<\/label>\s*\{view === 'irating' && \(\s*<input\s/);
    const row = SHELL.lastIndexOf('<div class="flex flex-wrap items-end gap-3">', search);
    expect(row).toBeGreaterThan(-1);
    expect(SHELL.slice(row, search)).not.toMatch(/<\/div>/);
  });

  it('keeps the search box’s label and classes, with no fixed width (AC1.4.3)', () => {
    const search = SHELL.indexOf('data-rating-search');
    const input = SHELL.slice(SHELL.lastIndexOf('<input', search), SHELL.indexOf('/>', search));
    expect(input).toContain('type="search"');
    expect(input).toContain('aria-label="Search drivers"');
    expect(input).toContain(`class="${SEARCH_CLASS}"`);
    expect(input).not.toMatch(/(?:^|[\s"])(?:\w+:)?w-/);
  });
});

describe('the ratings fragment', () => {
  it('reads the list and the timeline in one Promise.all (BR1.9, BR1.16)', () => {
    expect(FRAGMENT).toMatch(
      /await Promise\.all\(\[getSeriesRatings\(supabaseEnv, kind\), getRatingTimeline\(supabaseEnv\)\]\)/,
    );
    expect(FRAGMENT.split('getRatingTimeline(')).toHaveLength(2);
  });

  it('writes the slot list through safeJson, its only set:html (NFR3.4)', () => {
    expect(FRAGMENT).toContain('data-rating-timeline set:html={safeJson(timeline)}');
    expect(FRAGMENT.split('set:html')).toHaveLength(2);
  });

  it('has no subtitle under its heading', () => {
    expect(FRAGMENT).toMatch(/Series iRating<\/h2>\s*\{rows\.length === 0 && \(/);
  });
});

describe('the drawing code', () => {
  it('has no summary sentence anywhere under src/ (BR1.6)', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50);
    for (const [path, source] of Object.entries(SOURCES)) {
      expect(source, path).not.toContain('historySummary');
      expect(source, path).not.toContain('data-chart-summary');
    }
  });

  it('uses no innerHTML in the chart and no hex colour in the chart, trend or segment rule (NFR3.4, NFR4.1)', () => {
    expect(CHART).not.toContain('innerHTML');
    for (const [name, source] of Object.entries({ CHART, TREND, SEGMENTS })) {
      expect(source, name).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });
});

describe('the timeline read', () => {
  it('hints every embed by a constraint that exists in the baseline schema (BR1.17)', () => {
    const select = embedReads.ratingTimelineRounds.select;
    expect(select.endsWith(ROUND_EVENT_CATEGORY_SELECT)).toBe(true);
    expect(select).toContain('seasons!curated_rounds_season_id_fkey(');
    expect(BASELINE).not.toBe('');
    expect(BASELINE).toContain('ADD CONSTRAINT "curated_rounds_season_id_fkey"');
    expect(BASELINE).toContain('ADD CONSTRAINT "curated_rounds_event_id_fkey"');
    expect(BASELINE).toContain('ADD CONSTRAINT "events_subsession_id_fkey"');
  });

  it('encodes the select once when building the rounds path', () => {
    expect(SERIES_RATINGS).toContain('curated_rounds?select=${encodeURIComponent(RATING_TIMELINE_SELECT)}');
    expect(SERIES_RATINGS.split('encodeURIComponent(RATING_TIMELINE_SELECT)')).toHaveLength(2);
  });

  it('adds no read to the history endpoint (NFR1.2)', () => {
    expect(HISTORY).toContain('getSeriesRatingHistory(');
    expect(HISTORY).not.toContain('getRatingTimeline');
    expect(HISTORY).not.toContain('restGet');
  });

  it('keeps the timeline out of the masked-view list', () => {
    expect(Object.keys(privacyReads)).not.toContain('ratingTimelineRounds');
  });
});
