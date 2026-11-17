/**
 * Display polish (U2): shared compact table rows, the home podium card and the standings Laps, Led and CPI
 * columns (FR6, FR7, FR8, FR10).
 */
import { beforeAll, describe, expect, it } from 'vitest';

const MARKUP = import.meta.glob('/src/**/*.astro', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// Vitest empties .css imports, so the stylesheet is read from disk.
let GLOBAL_CSS = '';
beforeAll(async () => {
  const fs = await import('node:fs/promises' as string);
  GLOBAL_CSS = await fs.readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8');
});

const STANDINGS_FRAGMENT = MARKUP['/src/pages/standings/fragment.astro'];
const STANDINGS_SHELL = MARKUP['/src/pages/standings.astro'];
const HOME_FRAGMENT = MARKUP['/src/pages/home/fragment.astro'];

describe('shared row styles', () => {
  it('defines .data-table with the stripe that skips no-stripe and hidden rows, and .list-row', () => {
    expect(GLOBAL_CSS).toContain('.data-table > thead > tr > th');
    expect(GLOBAL_CSS).toContain(':nth-child(even of :not([data-no-stripe], [hidden], .hidden))');
    expect(GLOBAL_CSS).toContain('rgb(var(--fg) / 0.035)');
    expect(GLOBAL_CSS).toMatch(/\.list-row\s*\{/);
  });

  it('gives every table the shared style, except small layout tables', () => {
    const missing: string[] = [];
    for (const [file, text] of Object.entries(MARKUP)) {
      for (const tag of text.match(/<table\b[^>]*>/g) ?? []) {
        if (!/data-table|data-layout-table/.test(tag)) missing.push(file);
      }
    }
    expect(missing).toEqual([]);
  });

  it('marks every expandable detail row as no-stripe', () => {
    const unmarked = Object.entries(MARKUP)
      .filter(([, text]) => /<tr data-detail-row(?! data-no-stripe)/.test(text))
      .map(([file]) => file);
    expect(unmarked).toEqual([]);
  });
});

describe('standings Laps, Led and CPI columns', () => {
  it('adds the three sortable headers right of Poles, with the CPI hover text', () => {
    const poles = STANDINGS_FRAGMENT.indexOf('data-sort-key="poles"');
    const laps = STANDINGS_FRAGMENT.indexOf('data-sort-key="laps"');
    const led = STANDINGS_FRAGMENT.indexOf('data-sort-key="led"');
    const cpi = STANDINGS_FRAGMENT.indexOf('data-sort-key="cpi"');
    expect(poles).toBeGreaterThan(-1);
    expect(laps).toBeGreaterThan(poles);
    expect(led).toBeGreaterThan(laps);
    expect(cpi).toBeGreaterThan(led);
    expect(STANDINGS_FRAGMENT).toContain('<abbr title="Corners per Incident"');
  });

  it('gives the cells their own live hooks and formats CPI with formatCpi', () => {
    for (const hook of ['laps', 'led', 'cpi']) {
      expect(STANDINGS_FRAGMENT).toContain(`data-col="${hook}" data-live="${hook}"`);
    }
    expect(STANDINGS_FRAGMENT).toContain("from '../../lib/results/cpi'");
    expect(STANDINGS_SHELL).toContain("from '../lib/results/cpi'");
    expect(STANDINGS_SHELL).toContain("setText(r.row, 'laps'");
  });

  it('widens the detail row by three columns and the page container to max-w-7xl', () => {
    expect(STANDINGS_FRAGMENT).toContain("colspan={view === 'overall' ? 15 : 14}");
    expect(STANDINGS_SHELL).toContain('mx-auto max-w-7xl');
  });
});

describe('home Previous Result card', () => {
  it('builds the podium from podiumLayout with a privacy-safe photo', () => {
    expect(HOME_FRAGMENT).toContain('podiumLayout(tab.rows)');
    expect(MARKUP['/src/components/PodiumTile.astro']).toContain('driverPhoto(row.driver)');
    expect(MARKUP['/src/components/PodiumTile.astro']).toContain('driverInitialBadge(row.driver)');
  });

  it('labels the open-window link "Submit incident report"', () => {
    expect(HOME_FRAGMENT).toContain("label: 'Submit incident report'");
    expect(HOME_FRAGMENT).not.toContain("label: 'Submit Incident Report'");
  });
});
