/**
 * The driver profile's Weather and Track Type splits (driver-splits U7: BR1.12, BR1.13, BR1.14; NFR3.3,
 * NFR7.6). The wet-flags select names two FK constraints, and a src-only pull request skips the
 * migrations-rebuild embed check, so these pins keep the names, the single encoding and the untouched template
 * from drifting.
 */
import { describe, expect, it } from 'vitest';
import { ROUND_WET_FLAGS_SELECT } from '../../src/lib/db/events';
import embedReads from '../../src/lib/embedReads.json';
import privacyReads from '../../src/lib/privacyReads.json';
import EVENTS from '../../src/lib/db/events.ts?raw';
import LOAD from '../../src/lib/driverPage/load.ts?raw';
import FRAGMENT from '../../src/pages/drivers/[id]/fragment.astro?raw';
import CHAMPIONS_SEASON_RESULTS from '../../src/pages/champions/season-results/[seasonId]/[driverId].astro?raw';

const MIGRATIONS = import.meta.glob('/supabase/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const BASELINE = MIGRATIONS['/supabase/migrations/20261020120000_baseline_schema.sql'] ?? '';

/** The template after the frontmatter, without HTML comments, so a name mentioned only in prose does not count. */
function markup(source: string): string {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---/, '').replace(/<!--[\s\S]*?-->/g, '');
}

describe('driver splits: the wet flags read', () => {
  it('uses FK constraint names that exist in the baseline schema', () => {
    expect(BASELINE).not.toBe('');
    expect(BASELINE).toContain('ADD CONSTRAINT "curated_rounds_event_id_fkey"');
    expect(BASELINE).toContain('ADD CONSTRAINT "events_subsession_id_fkey"');
  });

  it('names both FK hints and is the string the CI embed check sends', () => {
    expect(ROUND_WET_FLAGS_SELECT).toContain('events!curated_rounds_event_id_fkey(');
    expect(ROUND_WET_FLAGS_SELECT).toContain('events!events_subsession_id_fkey(');
    expect(ROUND_WET_FLAGS_SELECT).toBe(embedReads.raceWetFlags.select);
  });

  it('encodes the select once when it builds the path', () => {
    expect(EVENTS).toContain('curated_rounds?select=${encodeURIComponent(ROUND_WET_FLAGS_SELECT)}');
    expect(EVENTS.match(/ROUND_WET_FLAGS_SELECT\)/g)).toHaveLength(1);
  });

  it('is kept out of privacyReads.json, which lists masked views only', () => {
    expect(Object.keys(privacyReads)).not.toContain('raceWetFlags');
  });
});

describe('driver splits: callers and the template (BR1.12, BR1.13)', () => {
  it('asks for wet flags only from the profile loader, not the champions season-results page', () => {
    expect(LOAD).toMatch(/getDriverRaceHistory\([^)]*\{\s*wetFlags:\s*true,?\s*\}\s*\)/);
    expect(CHAMPIONS_SEASON_RESULTS).toContain('getDriverRaceHistory(');
    expect(CHAMPIONS_SEASON_RESULTS).not.toContain('wetFlags');
  });

  it('draws the splits only through the two group loops, naming no group and with no set:html', () => {
    const html = markup(FRAGMENT);
    expect(html).toContain('splitGroupsOverall.map(');
    expect(html).toContain('splitGroupsClass.map(');
    expect(html).not.toContain('Weather');
    expect(html).not.toContain('Track Type');
    expect(FRAGMENT).not.toContain('set:html');
  });
});
