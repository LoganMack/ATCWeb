/**
 * Readers after the driver privacy contract step (U4: BR9.16, NFR8.3, NFR8.6): the eleven base tables behind
 * the masked views are readable only by admins, so every place in the site code that names one, as a request
 * path, a table argument or an embed in a select string, must be an admin path or a write the table's own
 * policies still allow. A new reference fails here until it is reviewed and added to REVIEWED. Also checks
 * the Deploy smoke check's data assertion, which catches a public reader that slips through.
 */
import { describe, expect, it } from 'vitest';
// Direct import, because import.meta.glob skips dot-folders such as .github.
import DEPLOY from '../../.github/workflows/deploy.yml?raw';

const SRC = import.meta.glob('/src/**/*.{astro,ts,json}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const BASE_TABLES = [
  'drivers',
  'curated_race_results',
  'curated_qualifying',
  'curated_practice_results',
  'kudos',
  'news_posts',
  'circuit_layouts',
  'penalties',
  'round_penalties',
  'champion_photos',
  'hall_of_fame_photos',
] as const;

/**
 * Every reviewed reference, per file and table, with how many there are. Each is an admin page's read (with
 * the admin's token), an admin write, or the kudos author's own delete ("author read own kudos").
 */
const REVIEWED: Record<string, Partial<Record<(typeof BASE_TABLES)[number], number>>> = {
  // getDistinctDriverCarNames: admin Site Properties.
  '/src/lib/db/assets.ts': { drivers: 1 },
  // Admin layout create, update and delete.
  '/src/lib/db/circuits.ts': { circuit_layouts: 3 },
  // getDriverById, getDriversForNumberCheck, getDriversForCustIdCheck, getDriversBasic (admin pages and
  // penaltyActions as the admin); create, update and delete (admin).
  '/src/lib/db/drivers.ts': { drivers: 7 },
  // Admin layout map save.
  '/src/lib/db/layoutMaps.ts': { circuit_layouts: 1 },
  // Admin news list, edit form, create, update and delete.
  '/src/lib/db/news.ts': { news_posts: 5 },
  // Admin penalty create, update and delete.
  '/src/lib/db/penalties.ts': { penalties: 3 },
  // Admin champion and Hall of Fame photo upserts and deletes.
  '/src/lib/db/photos.ts': { champion_photos: 2, hall_of_fame_photos: 2 },
  // deleteKudos: the author's own row, or an admin.
  '/src/lib/kudos.ts': { kudos: 1 },
  // getRaceInterviews: admin interviews list.
  '/src/lib/raceInterviews.ts': { drivers: 1 },
  // The admin results import: roster read, deletes, inserts and distinct round checks.
  '/src/lib/raceResultsImport.ts': {
    drivers: 1,
    curated_race_results: 3,
    curated_qualifying: 3,
    curated_practice_results: 3,
  },
  // Admin round penalty create, update and delete.
  '/src/lib/roundPenalties.ts': { round_penalties: 2 },
  // getSignupRoster: admin Sign-ups.
  '/src/lib/signups.ts': { drivers: 1 },
};

/** Comments removed, so prose such as "the `drivers` row" never counts. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** How many times `text` names `table` as a request path, a table argument or an embed. */
function references(text: string, table: string): number {
  const pattern = new RegExp(
    `rest/v1/${table}(?=[?'"\`])` + // a raw fetch
      `|['"\`]${table}\\?` + // a path with a query
      `|\\b(?:rest\\w*|distinctSubsessionIds)(?:<[^>]*>)?\\([^;]*?['"\`]${table}['"\`]` + // a table argument
      `|[,(:]${table}(?:!\\w+)?\\(`, // an embed in a select string
    'g',
  );
  return (stripComments(text).match(pattern) ?? []).length;
}

function found(): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [path, text] of Object.entries(SRC)) {
    for (const table of BASE_TABLES) {
      const n = references(text, table);
      if (n > 0) (out[path] ??= {})[table] = n;
    }
  }
  return out;
}

describe('base tables after the contract step (BR9.16, NFR8.3)', () => {
  it('names a base table only where reviewed as an admin path or an allowed write', () => {
    expect(found()).toEqual(REVIEWED);
  });

  it('recognises every form of reference, and not the masked views or prose', () => {
    expect(references(`restGet(env, 'drivers?select=id')`, 'drivers')).toBe(1);
    expect(references('fetch(`${env.url}/rest/v1/kudos?id=eq.1`)', 'kudos')).toBe(1);
    expect(references(`restPost<Row>(env, token, 'penalties', data)`, 'penalties')).toBe(1);
    expect(references(`'race_interviews?select=*,driver:drivers!driver_id(name)'`, 'drivers')).toBe(1);
    expect(references(`'news_post_drivers?select=post_id,drivers(id)'`, 'drivers')).toBe(1);
    expect(references(`restGet(env, 'drivers_shown?select=id')`, 'drivers')).toBe(0);
    expect(references(`'post_id,drivers:drivers_shown(id,name)'`, 'drivers')).toBe(0);
    expect(references(`// reads \`drivers\` rows\nconst kind = 'drivers';`, 'drivers')).toBe(0);
  });
});

describe('Deploy smoke check (NFR8.6)', () => {
  it('fails unless the live standings still link a driver', () => {
    expect(DEPLOY).toContain('"$site/standings/fragment"');
    expect(DEPLOY).toContain(`grep -q 'href="/drivers/' "$body"`);
  });
});
