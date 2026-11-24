/**
 * The admin circuit editor's page rules (admin/circuits/[id].astro and CircuitLayoutDialog.astro;
 * circuit-editor BR1.1 to BR1.3, BR1.7, BR1.8, BR1.10, BR1.11, BR1.13 to BR1.24, NFR7.5): the controller
 * validates before it writes and never writes a lap record, and the markup keeps the new labels, the icon
 * buttons, the dialog and the one plate helper.
 */
import { beforeAll, describe, expect, it } from 'vitest';

const raw = (files: Record<string, unknown>) => files as Record<string, string>;
const PAGE = raw(
  import.meta.glob('/src/pages/admin/circuits/[id].astro', { query: '?raw', import: 'default', eager: true }),
)['/src/pages/admin/circuits/[id].astro'];
const DIALOG = raw(
  import.meta.glob('/src/components/CircuitLayoutDialog.astro', { query: '?raw', import: 'default', eager: true }),
)['/src/components/CircuitLayoutDialog.astro'];
const ASTRO_FILES = raw(import.meta.glob('/src/**/*.astro', { query: '?raw', import: 'default', eager: true }));

const [FRONTMATTER, MARKUP] = (() => {
  const end = PAGE.indexOf('\n---', 4);
  return [PAGE.slice(0, end), PAGE.slice(end)];
})();
const LAYOUT_BRANCH = FRONTMATTER.slice(
  FRONTMATTER.indexOf("intent === 'add-layout'"),
  FRONTMATTER.indexOf("intent === 'delete-layout'"),
);

let GLOBAL_CSS = '';
beforeAll(async () => {
  const fs = await import('node:fs/promises' as string);
  GLOBAL_CSS = await fs.readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8');
});

describe('circuit editor controller', () => {
  it('parses every form through circuitEditorForm', () => {
    const imports = /import\s*\{([^}]*)\}\s*from\s*'..\/..\/..\/lib\/circuitEditorForm'/.exec(FRONTMATTER);
    expect(imports).not.toBeNull();
    for (const name of ['parseCircuitForm', 'parseLayoutForm', 'layoutSaveOutcome']) {
      expect(imports![1]).toContain(name);
    }
  });

  it('checks a layout save before any upload or activity log (BR1.19)', () => {
    expect(LAYOUT_BRANCH).not.toBe('');
    const outcome = LAYOUT_BRANCH.indexOf('layoutSaveOutcome(');
    expect(outcome).toBeGreaterThan(-1);
    expect(outcome).toBeLessThan(LAYOUT_BRANCH.indexOf('uploadToStorage('));
    expect(outcome).toBeLessThan(LAYOUT_BRANCH.indexOf('logActivity('));
  });

  it('sends the plate with the circuit, never as its own request (NFR1.2)', () => {
    expect(FRONTMATTER).not.toMatch(/updateCircuit\([^)]*\{\s*logo_background\b[^}]*\}\s*\)/);
  });

  it('reads no lap record field (BR1.17)', () => {
    expect(FRONTMATTER).not.toMatch(/form\.get\('lap_record_/);
    expect(FRONTMATTER).not.toContain('lap_record_');
  });
});

describe('circuit editor markup', () => {
  it('uses the five labels and drops the optional note and the four help texts (BR1.1, BR1.2)', () => {
    for (const label of ['Circuit Name', 'Location', 'Map Position', 'Logo', 'Logo Background']) {
      expect(MARKUP).toContain(`>${label}<`);
    }
    for (const gone of [
      'used by the Calendar',
      "Without these, this circuit's events",
      'PNG, JPG, WebP, or SVG',
      'A circuit can be run in more than one configuration',
      'Puts a plate behind this logo',
    ]) {
      expect(PAGE).not.toContain(gone);
    }
  });

  it('reads "Map & Pins" and "No track guides." (BR1.3, BR1.22)', () => {
    expect(MARKUP).toContain('Map &amp; Pins');
    expect(MARKUP).toContain('No track guides.');
    expect(MARKUP).not.toContain('None on file.');
  });

  it('has the two + buttons with a matching name and hover text and a hidden icon (BR1.13, BR1.23, BR1.24)', () => {
    for (const name of ['Add Layout', 'Add Track Guide']) {
      const button = new RegExp(`<button[^>]*aria-label="${name}"[^>]*>([\\s\\S]*?)</button>`).exec(MARKUP);
      expect(button, name).not.toBeNull();
      expect(button![0]).toContain(`title="${name}"`);
      expect(button![0]).toMatch(/class="btn btn-sm btn-neutral[^"]*after:-inset-1\.5/);
      expect(button![1]).toMatch(/<svg aria-hidden="true"/);
    }
    expect(MARKUP).toContain('data-open-dialog="layout-dialog-new"');
    expect(MARKUP).toContain('data-open-dialog="track-guide-dialog"');
  });

  it('leaves no <details> disclosure on the page', () => {
    expect(PAGE).not.toContain('<details');
  });

  it('has no lap record input on the page or in the dialog (BR1.15)', () => {
    expect(PAGE).not.toMatch(/name="lap_record_/);
    expect(DIALOG).not.toMatch(/lap_record_/);
  });

  it('gives the dialog a required Category, a linked alert and a labelled title (BR1.16, BR1.19)', () => {
    expect(DIALOG).toMatch(/<select name="category" required/);
    expect(DIALOG).toContain('Choose a category');
    expect(DIALOG).toContain('LAYOUT_CATEGORIES.map');
    expect(DIALOG).toContain('role="alert"');
    expect(DIALOG).toContain('aria-labelledby={titleId}');
    expect(DIALOG).toMatch(/'aria-invalid': 'true', 'aria-describedby': errorId/);
  });

  it('loads its behaviour from circuitEditor.ts, with no inline confirm script left', () => {
    expect(MARKUP).toMatch(/<script>\s*import '..\/..\/..\/scripts\/circuitEditor';\s*<\/script>/);
    expect(MARKUP).not.toContain('confirm(');
  });

  it('uses no set:html on the page or in the dialog', () => {
    expect(PAGE).not.toContain('set:html');
    expect(DIALOG).not.toContain('set:html');
  });

  it('writes the Logo Background as a radio group with a custom row (BR1.4, BR1.5)', () => {
    expect(MARKUP).toContain('<legend class="mb-1.5 text-white/70">Logo Background</legend>');
    expect(MARKUP).toContain('name="logo_background"');
    expect(MARKUP).toContain('aria-label="Pick custom colour"');
    expect(MARKUP).toContain('name="logo_background_hex"');
    expect(MARKUP).toContain('<span class="sr-only">Custom colour</span>');
    expect(MARKUP).toContain('name="had_logo_background"');
  });
});

describe('the logo plate', () => {
  it('is only ever written by logoBgAttrs in an .astro file (BR1.10, BR1.11)', () => {
    expect(Object.keys(ASTRO_FILES).length).toBeGreaterThan(50);
    for (const [path, source] of Object.entries(ASTRO_FILES)) {
      expect(source, path).not.toMatch(/data-logo-bg=|['"]data-logo-bg['"]/);
    }
    expect(MARKUP).toMatch(/data-logo-preview \{\.\.\.logoBgAttrs\(/);
  });

  it('has a custom rule in global.css drawn from --logo-bg', () => {
    expect(GLOBAL_CSS).toMatch(/img\[data-logo-bg='custom'\]\s*\{\s*background-color: var\(--logo-bg\);/);
  });
});
