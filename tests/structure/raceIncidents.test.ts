/**
 * Edit Results and race CPI (results-edit, US9.1-US9.4), checked in the source: the migration's access rules,
 * the page's handler and gating, the asterisk and CPI tips, and where the edit script loads. The database
 * behaviour itself is checked in supabase/checks/race-incidents-fixtures.sql.
 */
import { describe, expect, it } from 'vitest';

const read = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([path, text]) => [path, text.replace(/\r\n/g, '\n')]));

const SRC = read(
  import.meta.glob(['/src/**/*.astro', '/src/**/*.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>,
);
const SQL = read(
  import.meta.glob(
    ['/supabase/migrations/20261119120000_race_incident_adjustments.sql', '/supabase/down/*.sql'],
    {
      query: '?raw',
      import: 'default',
      eager: true,
    },
  ) as Record<string, string>,
);

const MIGRATION = SQL['/supabase/migrations/20261119120000_race_incident_adjustments.sql'];
const DOWN = SQL['/supabase/down/20261119120000_race_incident_adjustments.down.sql'];
const FRAGMENT = SRC['/src/pages/results/[subsessionId]/fragment.astro'];
const SHELL = SRC['/src/pages/results/[subsessionId].astro'];
const TABLE = SRC['/src/components/ResultsTable.astro'];
const CARD = SRC['/src/components/RaceSummaryCard.astro'];

/** One SQL statement starting at `start`, up to its terminating semicolon outside $$ bodies. */
function statement(sql: string, start: string): string {
  const from = sql.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  let inBody = false;
  for (let i = from; i < sql.length; i++) {
    if (sql.startsWith('$$', i)) {
      inBody = !inBody;
      i++;
    } else if (sql[i] === ';' && !inBody) return sql.slice(from, i + 1);
  }
  return sql.slice(from);
}

describe('the migration (BR9.1-BR9.11)', () => {
  it('closes the adjustments table to everyone but admins', () => {
    expect(MIGRATION).toContain('alter table public.race_incident_adjustments enable row level security;');
    expect(MIGRATION).toMatch(
      /revoke all on table public\.race_incident_adjustments from public, anon, authenticated;/,
    );
    expect(MIGRATION).toMatch(/grant select on table public\.race_incident_adjustments to authenticated;/);
    expect(MIGRATION).toMatch(/using \(private\.is_admin\(\)\)/);
    expect(MIGRATION).not.toMatch(/grant (insert|update|delete)[^;]*race_incident_adjustments/);
  });

  it('runs both definer functions with an empty search_path and checks for a full admin first', () => {
    const save = statement(MIGRATION, 'create function public.set_race_incidents');
    expect(save).toContain('security definer');
    expect(save).toContain("set search_path = ''");
    const body = save.slice(save.indexOf('begin'));
    expect(body.indexOf('private.is_full_admin()')).toBeGreaterThan(-1);
    expect(body.indexOf('private.is_full_admin()')).toBeLessThan(body.indexOf('jsonb_typeof'));
    const trigger = statement(MIGRATION, 'create function private.reapply_incident_adjustment');
    expect(trigger).toContain('security definer');
    expect(trigger).toContain("set search_path = ''");
    expect(MIGRATION).toMatch(
      /revoke all on function public\.set_race_incidents\(bigint, integer, jsonb\) from public, anon;/,
    );
    expect(MIGRATION).toMatch(
      /grant execute on function public\.set_race_incidents\(bigint, integer, jsonb\) to authenticated;/,
    );
  });

  it('changes the results in one update, so the round is re-scored once', () => {
    const save = statement(MIGRATION, 'create function public.set_race_incidents');
    expect(save.match(/update public\.curated_race_results\b/g)).toHaveLength(1);
  });

  it('never overwrites the original on a later save', () => {
    const save = statement(MIGRATION, 'create function public.set_race_incidents');
    const onConflict = save.slice(
      save.indexOf('on conflict'),
      save.indexOf(';', save.indexOf('on conflict')),
    );
    expect(onConflict).not.toContain('original_incidents');
  });

  it('adds original_incidents last to the masked view, keeping its options, and shows no editor', () => {
    const view = statement(MIGRATION, 'create or replace view public.curated_race_results_shown');
    expect(view).toContain('security_invoker = false');
    expect(view).toContain('security_barrier = true');
    expect(view).toMatch(/end as original_incidents\s+from public\.curated_race_results r/);
    expect(view).not.toMatch(/adjusted_by|adjusted_at/);
    expect(MIGRATION).toMatch(
      /grant select on table public\.curated_race_results_shown to anon, authenticated/,
    );
  });

  it('has a down script that restores the views and drops everything it added', () => {
    expect(DOWN).toBeDefined();
    for (const drop of [
      'drop trigger if exists reapply_incident_adjustment',
      'drop function if exists private.reapply_incident_adjustment()',
      'drop function if exists public.set_race_incidents(bigint, integer, jsonb)',
      'drop table if exists public.race_incident_adjustments',
    ])
      expect(DOWN).toContain(drop);
    expect(DOWN).toContain('create view public.curated_race_results_shown');
    expect(DOWN).toContain('create view public.round_best_laps_shown');
  });
});

describe('the Race Results page (US9.1)', () => {
  const adminBlock = FRAGMENT.slice(FRAGMENT.indexOf('if (adminSession && postForm) {'));
  const handler = adminBlock.slice(adminBlock.indexOf("if (intent === 'save-incidents')"));

  it('handles save-incidents inside the admin block, after save-race-links', () => {
    expect(adminBlock.indexOf("intent === 'save-race-links'")).toBeGreaterThan(-1);
    expect(adminBlock.indexOf("intent === 'save-incidents'")).toBeGreaterThan(
      adminBlock.indexOf("intent === 'save-race-links'"),
    );
  });

  it('checks for a full admin before saving and redirects to the shell page', () => {
    expect(handler.indexOf('isFullAdmin(adminSession.profile)')).toBeGreaterThan(-1);
    expect(handler.indexOf('isFullAdmin(adminSession.profile)')).toBeLessThan(
      handler.indexOf('saveRaceIncidents('),
    );
    expect(handler).toMatch(/return Astro\.redirect\(`\$\{shellPath\}/);
    expect(handler).toContain(
      "console.error('Failed to save incident counts:', { subsessionId, raceNumber, code })",
    );
  });

  it('shows the form and the inputs to full admins only', () => {
    expect(FRAGMENT).toContain(
      'const canEditResults = adminSession !== null && isFullAdmin(adminSession.profile);',
    );
    expect(FRAGMENT).toMatch(/\{canEditResults && \(\s*<form\s+id="edit-incidents-form"/);
    expect(FRAGMENT).toMatch(
      /\{category === 'race' && canEditResults && raceTableRows\.length > 0 && \(\s*<p[^>]*data-edit-incidents-error="edit-incidents-form"/,
    );
    expect(FRAGMENT).toContain("editIncidentsFormId={canEditResults ? 'edit-incidents-form' : null}");
    expect(TABLE).toContain('const editable = editIncidentsFormId !== null');
    expect(TABLE).toMatch(/\{editable && \(\s*<input/);
    expect(FRAGMENT).toMatch(/class="btn [^"]*"\s+data-edit-incidents-toggle/);
  });

  it('never caches a page showing the result banner', () => {
    expect(FRAGMENT).toContain("reportFlash || incidentsFlash ? 'private, no-store'");
    expect(FRAGMENT).toContain('if (canEditResults && isIncidentsResultCode(code))');
  });

  it('loads the edit script from the results page only', () => {
    expect(SHELL).toContain("import '../../scripts/editIncidents';");
    const importers = Object.entries(SRC)
      .filter(([, text]) => /scripts\/editIncidents['.]/.test(text))
      .map(([path]) => path);
    expect(importers).toEqual(['/src/pages/results/[subsessionId].astro']);
  });
});

describe('the asterisk and CPI tips (US9.2, US9.4)', () => {
  it('marks an adjusted count after the car number with IconTip', () => {
    expect(TABLE).toContain(
      'const adjustmentLabel = incidentAdjustmentLabel(row.originalIncidents, row.incidents);',
    );
    expect(TABLE).toMatch(/<IconTip label=\{adjustmentLabel\}>/);
    expect(TABLE.match(/#\{row\.driver\.car_number\}<\/span>\}\{adjustmentMark\}/g)).toHaveLength(2);
  });

  it('labels the race CPI "Corners per Incident"', () => {
    expect(CARD).toContain('<IconTip label="Corners per Incident">');
    expect(CARD).toContain('<abbr title="Corners per Incident"');
    expect(CARD.indexOf("label: 'CPI'")).toBeGreaterThan(CARD.indexOf("label: 'SOF'"));
    expect(FRAGMENT).toMatch(/wetFlags,\s+layoutCorners,\s+\}\)/);
  });
});
