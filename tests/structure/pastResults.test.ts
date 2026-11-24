/**
 * past-results (U8), the rules that live in markup and page code (BR8.1 to BR8.21, NFR1 to NFR5), read from
 * the sources as text like the other structure tests. Behaviour that needs data is in tests/lib/pastResults
 * and the popup and binder tests under tests/scripts.
 */
import { describe, expect, it } from 'vitest';
import embedReads from '../../src/lib/embedReads.json';
import { cacheQueryParams } from '../../src/lib/edgeCache';
import { ROUND_EVENT_CATEGORY_SELECT } from '../../src/lib/results/roundEligibility';

const raw = (files: Record<string, unknown>) => files as Record<string, string>;
const FILES = {
  ...raw(import.meta.glob('/src/**/*.astro', { query: '?raw', import: 'default', eager: true })),
  ...raw(import.meta.glob('/src/scripts/*.ts', { query: '?raw', import: 'default', eager: true })),
  ...raw(
    import.meta.glob('/tests/fixtures/incidentHistory/*.txt', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  ),
};

function source(path: string): string {
  const text = FILES[path];
  if (text === undefined) throw new Error(`${path} is missing`);
  return text;
}

/** Code without HTML and JS comments, so prose never satisfies a check. */
function code(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const frontmatter = (text: string) => text.split('---')[1] ?? '';
const markup = (text: string) => text.split('---').slice(2).join('---');

const BRIEFING = '/src/pages/briefing/[eventId].astro';
const LAYOUT = '/src/pages/circuits/layout-detail/[layoutId].astro';
const PROFILE = '/src/pages/drivers/[id]/fragment.astro';
const CIRCUITS = '/src/pages/circuits.astro';
const HISTORY = '/src/components/IncidentHistory.astro';
const DIALOG = '/src/components/IncidentDetailsDialog.astro';
const FIXTURE = '/tests/fixtures/incidentHistory/profileIncidentsPanel.txt';

const PAGES = [
  { name: 'briefing', path: BRIEFING, cache: 'public, s-maxage=60, stale-while-revalidate=300' },
  { name: 'layout row', path: LAYOUT, cache: 'public, s-maxage=120, stale-while-revalidate=600' },
];

describe('the past-results read fails the page closed (BR8.6, NFR1.1, NFR1.2, NFR2.1, NFR3.6)', () => {
  it.each(PAGES)(
    '$name: reads the excluded rounds inside the try, in one Promise.all, with no catch',
    ({ path, cache }) => {
      const fm = code(frontmatter(source(path)));
      const call = fm.indexOf('getLayoutExcludedRoundIds(');
      expect(call).toBeGreaterThan(-1);
      const tryAt = fm.lastIndexOf('try {', call);
      expect(tryAt).toBeGreaterThan(-1);
      expect(fm.slice(tryAt, call)).not.toContain('} catch');
      const all = fm.slice(fm.lastIndexOf('Promise.all([', call), fm.indexOf(']);', call));
      expect(all).toContain('getLayoutClassHighlights(');
      expect(all).toContain('getIncidentsForSubsessions(');
      expect(fm).not.toMatch(/getLayoutExcludedRoundIds\([^)]*\)\s*\.catch/);
      expect(fm).toContain('if (loadError) markUncacheable(Astro)');
      expect(fm).toContain(`'Cache-Control', '${cache}'`);
    },
  );

  it('keeps both routes out of the query-keyed edge cache', () => {
    expect(cacheQueryParams('/briefing/x')).toEqual([]);
    expect(cacheQueryParams('/circuits/layout-detail/x')).toEqual([]);
  });
});

describe('lists, dates and width (BR8.1, BR8.3, BR8.4, BR8.14, NFR1.5, NFR4.2)', () => {
  it.each(PAGES)('$name: every race, no "Race N" tag, "MMM DD, YYYY" dates', ({ path }) => {
    const text = code(source(path));
    expect(text).toContain('{ allRaces: true }');
    expect(text).not.toContain('Race {w.raceNumber}');
    expect(text).toContain('formatPastResultDate(w.round.startTime)');
    expect(text).toContain('formatPastResultDate(p.round.startTime)');
    expect(text).toContain('formatPastResultDate(r.startTime)');
    expect(text).toContain('?session=race-${w.raceNumber}');
  });

  it('widens the briefing one step', () => {
    const section = code(markup(source(BRIEFING))).match(/<section class="[^"]*"/)?.[0] ?? '';
    expect(section).toContain('max-w-5xl');
    expect(section).not.toContain('max-w-4xl');
  });
});

describe('reads go through src/lib (BR8.16, NFR3.1, NFR3.3)', () => {
  it.each(PAGES)('$name: no direct REST read, and incidents from the shared loader', ({ path }) => {
    const text = code(source(path));
    expect(text).not.toMatch(/\brestGet(All)?\b/);
    expect(text).not.toMatch(/\bfetch\(/);
    expect(text).toContain('getIncidentsForSubsessions(');
  });

  it('no longer reads penalties on the layout row', () => {
    expect(code(source(LAYOUT))).not.toContain('getPenaltiesForSubsessions');
  });
});

describe('IncidentHistory (BR8.9, BR8.10, BR8.12, BR8.18, NFR3.5, NFR4.1, NFR5.3)', () => {
  it('is rendered with details on both circuit pages and plain on the profile', () => {
    for (const { path } of PAGES) {
      const usage = code(markup(source(path))).match(/<IncidentHistory[^>]*\/>/)?.[0] ?? '';
      expect(usage).toMatch(/\bdetails\b/);
      expect(usage).not.toContain('highlightDriverId');
    }
    const profile = code(markup(source(PROFILE)));
    const panel = profile.slice(profile.indexOf('<div data-driver-panel="incidents" class="hidden">'));
    const inner = panel.slice(panel.indexOf('>') + 1, panel.indexOf('</div>')).trim();
    expect(inner).toBe('<IncidentHistory rows={driverIncidents} highlightDriverId={driverId} />');
  });

  it('renders the profile’s old inline markup exactly when details is off (BR8.9 comparison)', () => {
    const normalise = (text: string) =>
      code(text)
        .replace(/\s+/g, ' ')
        .replace(/\s*>\s*/g, '>')
        .replace(/\s*<\s*/g, '<')
        .trim();
    const old = normalise(source(FIXTURE))
      .replace(/\bdriverIncidents\b/g, 'rows')
      .replace(/\bdriverId\b/g, 'highlightDriverId');
    const component = normalise(markup(source(HISTORY)))
      .replace('highlightDriverId && ', '')
      .replace(/class=\{details \? '[^']*' : '([^']*)'\}/, 'class="$1"')
      .replace(/ [\w-]+=\{details \? [^}]* : undefined\}/g, '');
    expect(old).toContain('<tr class="border-b border-white/5">');
    expect(old).toContain('incidentDriverLabel(row)');
    expect(component).toBe(old);
  });

  it('adds the row attributes only under details, and keeps the plain row class', () => {
    const body = code(markup(source(HISTORY)));
    for (const attr of ['data-history-incident', 'tabindex', 'role', 'aria-haspopup']) {
      expect(body).toMatch(new RegExp(`${attr}=\\{details \\? [^}]+ : undefined\\}`));
      expect(body.match(new RegExp(`${attr}=`, 'g'))).toHaveLength(1);
    }
    expect(body).toContain(": 'border-b border-white/5'}");
    expect(body).toContain(
      "highlightDriverId && row.driver?.id === highlightDriverId ? 'py-2 pr-2 font-semibold text-white/90' : 'py-2 pr-2 text-white/60'",
    );
    expect(body).toContain('max-h-[32rem] overflow-auto');
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(body).not.toContain('set:html');
    expect(source(HISTORY)).not.toContain('<style');
  });
});

describe('the popup on the layout row (BR8.19, BR8.20, NFR1.3, NFR1.6, NFR3.4, NFR5.1)', () => {
  it('scopes the table and its own dialog, rendered only with rows, with a per-row title id', () => {
    const body = code(markup(source(LAYOUT)));
    const scope = body.slice(body.indexOf('<div class="mt-1.5" data-incident-details-scope>'));
    expect(scope.indexOf('<IncidentHistory')).toBeGreaterThan(-1);
    expect(scope).toMatch(
      /\{incidentRows\.length > 0 && \(\s*<IncidentDetailsDialog rows=\{incidentRows\} titleId=\{`incident-details-title-\$\{layoutRow\.id\}`\} \/>/,
    );
  });

  it('writes the popup data with safeJson, names the dialog by its heading, and reads nothing itself', () => {
    const dialog = code(source(DIALOG));
    expect(dialog).toContain('safeJson(incidentSummaryMap(');
    expect(dialog).not.toContain('incidentSummariesJson');
    expect(dialog).toContain('aria-labelledby={titleId}');
    expect(dialog).toContain('id={titleId}');
    expect(dialog).not.toMatch(/from '[./]*lib\/db\//);
  });
});

describe('client scripts (BR8.13, BR8.20, BR8.21, NFR1.8, NFR3.5, NFR5.2)', () => {
  it('loads the row loader, the search and the popup script on /circuits, with no inline search', () => {
    const page = code(source(CIRCUITS));
    expect(page).toContain("import '../scripts/circuitLayoutDetail';");
    expect(page).toContain("import '../scripts/circuitSearch';");
    expect(page).toContain("import '../scripts/incidentDetails';");
    expect(page).not.toContain('function initCircuitSearch');
  });

  it('binds the search once and keeps its own page-load registration', () => {
    const search = code(source('/src/scripts/circuitSearch.ts'));
    expect(search).toContain('export function initCircuitSearch');
    expect(search).toContain(`querySelector('[id="circuit-search"]')`);
    expect(search).toContain("input.dataset.searchBound === 'true'");
    expect(search).toContain("document.addEventListener('astro:page-load', initCircuitSearch)");
    expect(code(source('/src/scripts/sortable-table.ts'))).toContain('export function initSortableTables');
  });

  it('re-dispatches astro:page-load once, after the fragment lands and before the catch', () => {
    const loader = code(source('/src/scripts/circuitLayoutDetail.ts'));
    const dispatch = "dispatchEvent(new Event('astro:page-load'))";
    expect(loader.split(dispatch)).toHaveLength(2);
    expect(loader.indexOf(dispatch)).toBeGreaterThan(loader.indexOf('body.innerHTML = await res.text()'));
    expect(loader.indexOf(dispatch)).toBeLessThan(loader.indexOf('} catch'));
  });

  it('fills the popup with text only and finds the dialog by tag name', () => {
    const popup = code(source('/src/scripts/incidentDetails.ts'));
    expect(popup).not.toContain('innerHTML');
    expect(popup).not.toContain('instanceof HTMLDialogElement');
    expect(popup).toContain("closest('[data-incident-details-scope]')");
  });
});

describe('the category select (BR8.16, a later src-only PR skips the CI embed check)', () => {
  it('is the round id plus the shared category select', () => {
    expect(embedReads.pastResultsRoundEvents.select).toBe('subsession_id,' + ROUND_EVENT_CATEGORY_SELECT);
  });
});
