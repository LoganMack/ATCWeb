/**
 * The seasons and TBD tweaks: the Admin > Seasons markup (FR1.2, FR1.4, FR3.1-FR3.6), the italic rule's layer
 * and the Compare classes (FR2), and the TBD card, name and icon (FR4).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  getEventCardClasses,
  getEventCardHoverClasses,
  TBD_CARD_CLASSES,
  TBD_CARD_HOVER_CLASSES,
} from '../../src/lib/eventFormatting';

const read = (glob: Record<string, string>) =>
  Object.fromEntries(Object.entries(glob).map(([path, text]) => [path, text.replace(/\r\n/g, '\n')]));
const SRC = read(
  import.meta.glob(['/src/**/*.astro', '/src/**/*.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>,
);

// Read from disk: Vite runs .css imports through PostCSS, which resolves the @layer blocks.
const GLOBAL_CSS = readFileSync('src/styles/global.css', 'utf8').split('\r').join('');

describe('Admin > Seasons (FR1, FR3)', () => {
  const page = SRC['/src/pages/admin/seasons/index.astro'];
  const rowStart = page.indexOf('data-season-row');
  const row = page.slice(rowStart, page.indexOf('recalcResult && recalcResult.seasonId', rowStart));

  it('titles the new-season card "Add Season", with a read-only name kept in step by its page script', () => {
    expect(page).toContain('Add Season');
    expect(page).not.toContain('Create season');
    expect(page).not.toMatch(/>\s*New season\s*</);
    expect(page).toMatch(/name="name"\s+readonly/);
    expect(page).toContain('data-season-number');
    expect(page).toContain('data-season-name');
    expect(page).toContain("import '../../../scripts/seasonNameSync';");
  });

  it('removes logos by the picture, not by text links', () => {
    expect(page).not.toContain('Remove Dark');
    expect(page).not.toContain('Remove Light');
    expect(row).toContain('form={`remove-dark-${season.id}`}');
    expect(row).toContain('form={`remove-light-${season.id}`}');
    expect(row).toContain('aria-label={`Remove dark logo for ${season.name}`}');
    expect(row).toContain('aria-label={`Remove light logo for ${season.name}`}');
    expect(row).toContain('id={`remove-dark-${season.id}`}');
    expect(row).toMatch(/group-hover:opacity-40 group-focus-visible:opacity-40/);
    expect(row).toContain('×');
  });

  it('saves the whole row with one Save: nothing in a season row saves on change', () => {
    expect(row).not.toContain('data-submit-on-change');
    for (const field of [
      'logo_url',
      'logo',
      'logo_url_light',
      'logo_light',
      'scoring_ruleset_id',
      'gamma_enabled',
    ]) {
      expect(row).toMatch(
        new RegExp(`name="${field}"\\s+(value="1"\\s+)?form=\\{\`save-\\$\\{season\\.id\\}\`\\}`),
      );
    }
  });

  it('puts Recalculate then Save in the bottom-right actions, with the confirm kept on the recalculate form', () => {
    const at = row.indexOf('data-season-actions');
    const actions = row.slice(row.lastIndexOf('<div', at), row.indexOf('</div>', at));
    expect(actions).toContain('justify-end');
    expect(actions.indexOf('Recalculate')).toBeGreaterThan(-1);
    expect(actions.indexOf('Recalculate')).toBeLessThan(actions.indexOf('Save'));
    expect(row).toMatch(/id=\{`recalc-\$\{season\.id\}`\}[\s\S]*?data-confirm=/);
  });
});

describe('Italics (FR2.1, FR2.3)', () => {
  it('keeps the display font italic in the base layer, so not-italic can win', () => {
    const css = GLOBAL_CSS;
    const rule = css.search(/\.font-display \{\s*font-style: italic;/);
    const layer = css.lastIndexOf('@layer base {', rule);
    expect(layer).toBeGreaterThan(-1);
    expect(rule).toBeGreaterThan(layer);
    expect(css.slice(layer, rule)).toContain('h4,');
    expect(css.slice(layer, rule)).not.toContain('}');
  });

  it('sets the Compare names, type labels, stat labels and values upright', () => {
    const tower = SRC['/src/scripts/compareTower.ts'];
    expect(tower).toMatch(/const nameClass =\s*'[^']*not-italic/);
    expect(tower).toMatch(/font-bold uppercase not-italic tracking-wider/);
    expect(tower.match(/not-italic/g)?.length).toBeGreaterThanOrEqual(6);
  });
});

describe('TBD cards (FR4)', () => {
  const tbd = { category: 'championship' as const, format: 'sprint' as const, circuit_id: null };

  it('gives a TBD event the gradient background instead of the sprint gold', () => {
    expect(getEventCardClasses(tbd)).toBe(TBD_CARD_CLASSES);
    expect(getEventCardHoverClasses(tbd)).toBe(TBD_CARD_HOVER_CLASSES);
    expect(TBD_CARD_CLASSES).toContain('via-[color:var(--card-gold)]');
    expect(getEventCardHoverClasses({ ...tbd, circuit_id: 'c1' })).toContain('bg-brand-gold/10');
    // A caller that does not pass the circuit is never treated as TBD.
    expect(getEventCardClasses({ category: 'championship', format: 'sprint' })).not.toBe(TBD_CARD_CLASSES);
  });

  it('uses the normal text colour for TBD names and a plain white icon', () => {
    for (const file of ['UpcomingEventCard', 'EventDetailCard']) {
      expect(SRC[`/src/components/${file}.astro`]).not.toContain('tbd-gradient');
    }
    expect(GLOBAL_CSS).not.toContain('.tbd-gradient');
    const tile = SRC['/src/components/TbdTile.astro'];
    expect(tile).toContain('bg-fixed-white');
    expect(tile).toContain('text-fixed-ink');
    expect(tile).not.toContain('bg-gradient');
  });

  it('puts the gradient on the Calendar card of a TBD event', () => {
    expect(SRC['/src/components/EventDetailCard.astro']).toContain(
      "tbd ? TBD_CARD_CLASSES : 'border-white/10 bg-brand-ink'",
    );
  });
});
