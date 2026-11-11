/**
 * Round polish (FR1-FR6), checked in the source: the event form's To Be Determined option and its script, the
 * Admin Events page, Add Comment for admins and staff, the Reported Incidents report link and video thumbnails,
 * the dashboard card, the season logo dropdowns and "All", and the Compare view's removed text.
 */
import { describe, expect, it } from 'vitest';

// Line endings normalised, so a Windows checkout reads the same as CI.
const SRC = Object.fromEntries(
  Object.entries(
    import.meta.glob(['/src/**/*.astro', '/src/**/*.ts'], {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ).map(([path, text]) => [path, text.replace(/\r\n/g, '\n')]),
);

const EVENT_FORM = SRC['/src/pages/admin/events/[id].astro'];
const EVENTS = SRC['/src/pages/admin/events/index.astro'];
const INCIDENTS = SRC['/src/pages/results/[subsessionId]/incidents/fragment.astro'];
const SUBMISSIONS = SRC['/src/pages/results/[subsessionId]/incidents/submissions/fragment.astro'];
const DASHBOARD = SRC['/src/pages/admin/fragment.astro'];
const COMPARE = SRC['/src/pages/advanced-stats/fragment.astro'];

describe('the event form (FR4)', () => {
  it('offers To Be Determined first in the circuit dropdown, selected for a TBD event', () => {
    const select = EVENT_FORM.slice(EVENT_FORM.indexOf('id="circuit_id"'));
    const firstOption = select.slice(select.indexOf('<option'));
    expect(firstOption).toMatch(
      /^<option value=\{TBD_CIRCUIT_VALUE\} selected=\{tbdSelected\}[^>]*>To Be Determined<\/option>/,
    );
    expect(EVENT_FORM).toContain('const tbdSelected = event ? isTbdEvent(event) : false;');
  });

  it('clears a TBD save on the server and still requires a circuit otherwise', () => {
    expect(EVENT_FORM).toContain('if (isTbdChoice(form, category)) return applyTbd(');
    expect(EVENT_FORM).toContain('} else if (!circuitless && !tbd && !data.circuit_id) {');
    expect(EVENT_FORM).toContain("const raceRequired = data.category !== 'test' && !circuitless && !tbd;");
  });

  it('has no helper text under any input', () => {
    expect(EVENT_FORM).not.toContain('text-xs text-white/40');
  });

  it('loads the TBD script on this page only', () => {
    const importers = Object.entries(SRC)
      .filter(([, text]) => text.includes('scripts/eventTbdForm'))
      .map(([path]) => path);
    expect(importers).toEqual(['/src/pages/admin/events/[id].astro']);
    const script = SRC['/src/scripts/eventTbdForm.ts'];
    for (const name of ['layout', 'format', 'fuel_limit_pct', 'rules', 'results_url']) {
      expect(script).toContain(`'${name}'`);
    }
    expect(script).toContain("'#session-fields fieldset'");
  });

  it('shows TBD, not TBA, where an event has no circuit', () => {
    for (const path of [
      '/src/components/EventDetailCard.astro',
      '/src/components/UpcomingEventCard.astro',
      '/src/pages/calendar/fragment.astro',
      '/src/pages/briefing/[eventId].astro',
      '/src/pages/admin/events/index.astro',
      '/src/lib/ics.ts',
    ]) {
      expect(SRC[path], path).not.toContain("'TBA'");
      expect(SRC[path], path).toContain('TBD_LABEL');
    }
  });
});

describe('Admin Events (FR3)', () => {
  it('collapses Orphaned Rounds, opening it after a Link attempt or a load error', () => {
    expect(EVENTS).toMatch(/<details\s+id="orphaned-rounds"/);
    expect(EVENTS).toContain('open={flash || orphanLoadError ? true : undefined}');
    expect(EVENTS).toContain('</details>');
  });

  it('has no Orphaned Rounds subtitle and no CSV import', () => {
    expect(EVENTS).not.toContain("Imported rounds that aren't fully connected yet.");
    expect(EVENTS).not.toContain('/admin/import');
    expect(EVENTS).not.toContain('Import from CSV');
  });
});

describe('incident submissions (FR1)', () => {
  it('gives admins and staff Add Comment on the submissions above an unposted report', () => {
    expect(INCIDENTS).toContain(
      '<IncidentSubmissionsTables sessions={adminSubmissionSessions} showActions />',
    );
    expect(INCIDENTS).toContain('<IncidentCommentDialog action={adminCommentAction} />');
    expect(INCIDENTS).toMatch(/data-admin-submissions data-incident-management/);
  });

  it('drops the subtitle from the public Incident Submissions page', () => {
    expect(SUBMISSIONS).not.toContain('The incidents reported for this round.');
  });
});

describe('Reported Incidents (FR2)', () => {
  it('labels the report link Preview Report until the round is posted', () => {
    expect(INCIDENTS).toContain("const reportToggleLabel = roundPosted ? 'View Report' : 'Preview Report';");
  });

  it('puts a desktop copy of the link at the right end of the filter row', () => {
    const bar = INCIDENTS.slice(INCIDENTS.indexOf('data-incident-filters>'));
    const end = bar.indexOf('</div>');
    expect(bar.slice(0, end)).toContain('data-testid="incident-view-toggle-desktop"');
    expect(bar.slice(0, end)).toContain('hidden lg:ml-auto lg:inline-flex');
    expect(INCIDENTS).toContain("class={`btn btn-neutral${showIncidentList ? ' lg:hidden' : ''}`}");
  });

  it('shows each video as a thumbnail the size of the map that opens the popup player', () => {
    const thumb = SRC['/src/components/ClipThumbnail.astro'];
    expect(thumb).toContain('aspect-square w-36');
    expect(thumb).toContain('xl:w-40');
    expect(thumb).toContain('data-open-video');
    expect(thumb).toContain('aria-label="Watch video"');
    expect(INCIDENTS).not.toContain('data-inline-clip');
  });
});

describe('the dashboard latest-event card (FR5)', () => {
  it('shows the title, the track on its own line, the two counts, then the two windows', () => {
    expect(DASHBOARD).toContain('{latestEvent.summary.title}');
    expect(DASHBOARD).toContain('data-testid="latest-event-track"');
    expect(DASHBOARD).toContain("toReviewLabel(latestEvent.summary.incidentsToReview, 'Incident')");
    expect(DASHBOARD).toContain("toReviewLabel(latestEvent.summary.appealsToReview, 'Appeal')");
    expect(DASHBOARD.indexOf('data-testid="latest-event-counts"')).toBeLessThan(
      DASHBOARD.indexOf('data-testid="latest-event-windows"'),
    );
  });
});

describe('season dropdowns (FR6.1, FR6.2)', () => {
  it('shows season logos on Compare, Interviews, Kudos and Liveries', () => {
    for (const path of [
      '/src/pages/advanced-stats.astro',
      '/src/pages/interviews/fragment.astro',
      '/src/pages/kudos/fragment.astro',
      '/src/components/LiveriesPanel.astro',
    ]) {
      expect(SRC[path], path).toContain('data-logo-select');
      expect(SRC[path], path).toContain('seasonOptionAttrs(');
    }
    expect(SRC['/src/components/LiveriesPanel.astro'].match(/data-logo-select/g)).toHaveLength(2);
  });

  it('labels the every-season option All', () => {
    expect(SRC['/src/pages/news/fragment.astro']).toContain('>All</option>');
    expect(SRC['/src/pages/calendar/fragment.astro']).toContain('>All</option>');
    for (const text of Object.values(SRC)) expect(text).not.toMatch(/>All [Ss]easons</);
  });
});

describe('Compare (FR6.3-FR6.9)', () => {
  it('has no filter subtitle, race-laps note or ATC Compare title', () => {
    expect(COMPARE).not.toContain('data-compare-summary');
    expect(COMPARE).not.toContain('compare-race-laps-note');
    expect(SRC['/src/scripts/compareTower.ts']).not.toContain("'ATC Compare'");
  });
});
