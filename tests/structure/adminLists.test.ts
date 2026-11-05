/**
 * List tidy-ups (FR3, FR4.1, FR4.2; BR3.1, BR4.6): the admin Incident Reporting links and their phone hiding,
 * and the Race Results list showing race winners from one call instead of Grid and SoF.
 */
import { describe, expect, it } from 'vitest';

const SRC = import.meta.glob('/src/pages/**/*.astro', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('admin Incident Reporting list (BR3.1)', () => {
  const page = SRC['/src/pages/admin/incident-reporting/index.astro'];

  it('names the links Review Submissions and Preview Report / View Report', () => {
    expect(page).toContain('>Review Submissions</a>');
    expect(page).toContain(">{r.posted ? 'View Report' : 'Preview Report'}</a>");
    expect(page).not.toContain('View Incidents</a>');
    expect(page).not.toContain("'Edit Report'");
  });

  it('hides the Post Date column and the second link on phones', () => {
    expect(page).toContain('<th class="hidden px-3 py-3 font-semibold sm:table-cell">Post Date</th>');
    expect(page).toMatch(/<td class=\{`hidden whitespace-nowrap px-3 py-3 tabular-nums sm:table-cell /);
    expect(page).toMatch(
      /class=\{`hidden w-28 [^`]*sm:inline-block [^`]*`\}\s*data-testid="incident-reporting-report-link"/,
    );
  });
});

describe('Race Results list (FR4)', () => {
  const page = SRC['/src/pages/results/fragment.astro'];

  it('drops Grid and SoF', () => {
    expect(page).not.toMatch(/>Grid \{/);
    expect(page).not.toMatch(/>SoF \{/);
    expect(page).not.toContain('strength_of_field');
  });

  it('loads every listed round’s winners in one call alongside the layouts', () => {
    expect(page.match(/getRaceWinnersForRounds\(/g)).toHaveLength(1);
    expect(page).toMatch(
      /await Promise\.all\(\[\s*getRoundLayoutsForSubsessions\(supabaseEnv, roundIds\),\s*getRaceWinnersForRounds\(supabaseEnv, roundIds\),/,
    );
  });

  it('shows one line per race with class badges for drivers and logos for teams', () => {
    expect(page).toContain('data-testid="race-winners"');
    expect(page).toContain("{races.length > 1 ? `Race ${race.raceNumber}` : 'Race'}");
    expect(page).toContain('<ClassBadge className={SLOT_CLASS_NAME[w.slot]} />');
    expect(page).toContain('<TeamLogo name={w.name} logoUrl={w.logoUrl} size="h-5 w-5" />');
  });
});
