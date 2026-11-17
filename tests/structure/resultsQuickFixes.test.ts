/**
 * Results quick fixes (FR1, FR3, FR4, FR6), checked in the source: Edit Results' icon buttons, the podium's
 * gold, silver and bronze in both themes, the podium step, and the subtitles that were removed.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([path, text]) => [path, text.replace(/\r\n/g, '\n')]));

const SRC = read(
  import.meta.glob(['/src/**/*.astro'], { query: '?raw', import: 'default', eager: true }) as Record<
    string,
    string
  >,
);

const RESULTS = SRC['/src/pages/results/[subsessionId]/fragment.astro'];
const ROUND_INCIDENTS = SRC['/src/pages/results/[subsessionId]/incidents/fragment.astro'];
const ALL_INCIDENTS = SRC['/src/pages/incidents/fragment.astro'];
const PODIUM = SRC['/src/components/PodiumTile.astro'];
const CSS = readFileSync('src/styles/global.css', 'utf8').split('\r').join('');
const TAILWIND = readFileSync('tailwind.config.mjs', 'utf8').split('\r').join('');

/** The opening tag of the button carrying `marker`. */
function buttonWith(marker: string): string {
  const at = RESULTS.indexOf(marker);
  expect(at, marker).toBeGreaterThan(-1);
  const start = RESULTS.lastIndexOf('<button', at);
  return RESULTS.slice(start, RESULTS.indexOf('>', at) + 1);
}

describe('the files under test', () => {
  it('are all found', () => {
    for (const text of [RESULTS, ROUND_INCIDENTS, ALL_INCIDENTS, PODIUM, CSS, TAILWIND]) expect(text).toBeDefined();
  });
});

describe('Edit Results icon buttons (FR1.1-FR1.4)', () => {
  it('uses icon-only .btn buttons, each with a title, an aria-label and a test id', () => {
    for (const [marker, label, testId] of [
      ['data-edit-incidents-toggle', 'Edit results', 'edit-results-toggle'],
      ['data-edit-incidents-cancel', 'Cancel', 'edit-results-cancel'],
    ]) {
      const tag = buttonWith(marker);
      expect(tag).toMatch(/class="btn btn-neutral btn-sm( hidden)?"/);
      expect(tag).toContain(`aria-label="${label}"`);
      expect(tag).toContain(`title="${label}"`);
      expect(tag).toContain(`data-testid="${testId}"`);
    }
    expect(RESULTS).not.toMatch(/>\s*Edit Results\s*</);
    expect(RESULTS).not.toMatch(/>\s*Cancel\s*</);
  });

  it('has a pencil, a hidden tick and a cross', () => {
    expect(RESULTS).toMatch(/<svg data-icon="edit" class="h-4 w-4"/);
    expect(RESULTS).toMatch(/<svg data-icon="save" class="hidden h-4 w-4"/);
    expect(buttonWith('data-edit-incidents-cancel')).toContain('hidden');
  });

  it('places the column out of the flow, just right of the table, and hidden until it fits', () => {
    expect(RESULTS).toMatch(/<div class="relative">\s*\{\/\*[\s\S]*?\*\/\}\s*\{canEditResults && \(\s*<form/);
    expect(RESULTS).toContain('class="absolute left-full top-0 ml-2 hidden flex-col gap-2"');
  });
});

describe('podium colours and step (FR3, FR4.1)', () => {
  it('rings and numbers 1st gold, 2nd silver and 3rd bronze', () => {
    expect(PODIUM).toContain(
      "const ring = place === 1 ? 'ring-brand-gold' : place === 2 ? 'ring-brand-silver' : 'ring-brand-bronze';",
    );
    expect(PODIUM).toContain(
      "const placeText = place === 1 ? 'text-brand-gold' : place === 2 ? 'text-brand-silver' : 'text-brand-bronze';",
    );
    expect(PODIUM).not.toMatch(/ring-white\/60|ring-brand-pink/);
  });

  it('steps the podium a quarter rem per place, 1st highest', () => {
    // Bottom margins: the podium grid aligns its tiles to the bottom, where a top margin moves nothing.
    expect(PODIUM).toContain("const lift = place === 1 ? 'mb-2' : place === 2 ? 'mb-1' : 'mb-0';");
  });

  it('defines silver and bronze as theme tokens with a value in each theme', () => {
    for (const token of ["silver: themed('--silver')", "bronze: themed('--bronze')"])
      expect(TAILWIND).toContain(token);
    for (const token of ["silver: themed('--text-silver')", "bronze: themed('--text-bronze')"])
      expect(TAILWIND).toContain(token);
    for (const name of ['--silver', '--bronze', '--text-silver', '--text-bronze'])
      expect(CSS.match(new RegExp(`${name}: \\d+ \\d+ \\d+;`, 'g')), name).toHaveLength(2);
  });
});

describe('removed subtitles (FR6)', () => {
  it('drops the round incidents subtitle and the "yet" line', () => {
    expect(ROUND_INCIDENTS).not.toContain('What everyone else sees on this page until the round is posted.');
    expect(ROUND_INCIDENTS).not.toContain('No incidents logged yet.');
  });

  it('keeps "No incidents logged for this round." where it applies', () => {
    expect(ROUND_INCIDENTS).toMatch(
      /openReportCount === 0 && \(\s*<p class="mt-10 text-white\/60">No incidents logged for this round\.<\/p>/,
    );
  });

  it('drops "No incidents logged yet." from the all-incidents page', () => {
    expect(ALL_INCIDENTS).not.toContain('No incidents logged yet.');
  });
});
