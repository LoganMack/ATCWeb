/**
 * Page-level rules of the seasons and results polish: the Site Properties incident window text (FR7), the
 * results page's race card and heading (FR3.3, FR3.4), Season Stats (FR5) and the poll editor subtitle (FR8.3).
 */
import { describe, expect, it } from 'vitest';
import { cacheKeyUrl } from '../../src/lib/edgeCache';

const SRC = Object.fromEntries(
  Object.entries(
    import.meta.glob('/src/**/*.astro', { query: '?raw', import: 'default', eager: true }) as Record<
      string,
      string
    >,
  ).map(([path, text]) => [path, text.replace(/\r\n/g, '\n')]),
);

describe('Site Properties incident windows (FR7, BR7.1)', () => {
  const page = SRC['/src/pages/admin/site-properties/index.astro'];

  it('shows the two exact descriptions and names each input by its description', () => {
    expect(page).toContain("How many hours drivers can report incidents after a round's race ends.");
    expect(page).toContain(
      "How many hours drivers can submit an appeal for an incident after you post the round's incident report.",
    );
    expect(page).toContain('aria-label={REPORTING_WINDOW_DESCRIPTION}');
    expect(page).toContain('aria-label={APPEAL_WINDOW_DESCRIPTION}');
  });

  it('no longer shows the old visible labels', () => {
    expect(page).not.toContain('Reporting window (hours)');
    expect(page).not.toContain('Appeal window (hours)');
  });
});

describe('round results page (FR3.3, FR3.4)', () => {
  const fragment = SRC['/src/pages/results/[subsessionId]/fragment.astro'];

  it('drops the date line under the track name and renders the race card after the filter card', () => {
    expect(fragment).not.toContain('formatDate(round.start_time)');
    const filterCard = fragment.indexOf('<div class="mt-12 relative z-30 rounded-xl border border-white/10');
    const card = fragment.indexOf('<RaceSummaryCard card={raceCard} />');
    const table = fragment.indexOf('<ResultsTable');
    expect(filterCard).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(filterCard);
    expect(table).toBeGreaterThan(card);
  });

  it('makes every results column sortable and drops the average-lap hover', () => {
    const table = SRC['/src/components/ResultsTable.astro'];
    expect(table).toContain('<table class="w-full border-collapse" data-sortable>');
    for (const key of [
      'pos',
      'driver',
      'class',
      'margin',
      'start',
      'incidents',
      'laps',
      'led',
      'best',
      'classpts',
    ]) {
      expect(table, key).toContain(`data-sort-key="${key}"`);
      expect(table, key).toContain(`data-col="${key}"`);
    }
    expect(table).not.toContain('Avg lap:');
  });

  it('explains SOF on hover and keyboard focus', () => {
    const card = SRC['/src/components/RaceSummaryCard.astro'];
    expect(card).toContain('tabindex="0"');
    expect(card).toContain('Strength of Field');
  });
});

describe('Season Stats (FR5)', () => {
  it('has a shell with the banner, picker, search and class select, and a cached fragment', () => {
    const shell = SRC['/src/pages/season-stats.astro'];
    expect(shell).toContain("bannerUrlFor(await getPageBanners(supabaseEnv), 'season-stats')");
    expect(shell).toContain('<StatsTabs active="seasons" />');
    expect(shell).toContain('id="season-stats-search"');
    for (const label of ['Overall', 'Alpha', 'Gamma', 'Delta']) expect(shell).toContain(`label: '${label}'`);
    expect(shell).not.toContain('Combined');
    const fragment = SRC['/src/pages/season-stats/fragment.astro'];
    expect(fragment).toContain(
      "Astro.response.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');",
    );
    expect(fragment).toContain('if (loadError) markUncacheable(Astro);');
    expect(fragment).toContain('data-sortable');
  });

  it('keys the edge cache on the three class values only', () => {
    const key = (q: string) => cacheKeyUrl(new URL(`https://atc.example/season-stats/fragment${q}`));
    expect(key('?class=gamma')).toBe('https://atc.example/season-stats/fragment?class=gamma');
    expect(key('?class=overall')).toBe('https://atc.example/season-stats/fragment');
    expect(key('?class=Gamma')).toBe('https://atc.example/season-stats/fragment');
    expect(key('?class=gamma&x=1')).toBe('https://atc.example/season-stats/fragment?class=gamma');
  });
});

describe('poll editor (FR8.3)', () => {
  it('drops the image size subtitle', () => {
    expect(SRC['/src/components/PollEditor.astro']).not.toContain('Images are PNG, JPEG or WebP');
  });
});
