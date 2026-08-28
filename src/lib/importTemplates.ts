/**
 * CSV template generation for the 6 admin importers split across
 * /admin/import-tools (Events, Circuits, News) and /admin/import (Race,
 * Qualifying, Practice Results). Templates used to be static files under
 * public/ — the risk with that (and the reason this file exists instead) is
 * that nothing forces a static file to stay in sync with the columns an
 * importer actually reads; it's easy to add/rename a column in the parsing
 * code and forget the template ever existed. Generating the template from
 * the SAME column list documented here, served on demand by
 * src/pages/api/import-templates/[kind].ts, means there's exactly one place
 * to update when an importer's columns change — do that here, and the
 * downloadable template updates itself on the next request, no separate
 * file to remember.
 *
 * Each importer's own parsing code (src/pages/admin/import-tools/index.astro
 * for Events/Circuits/News; src/lib/raceResultsImport.ts for Race/
 * Qualifying/Practice Results) reads columns by name via
 * `header.indexOf(name)`, not by position, so it doesn't strictly depend on
 * this file at runtime — but every column an importer looks for should have
 * a matching entry here, and this is the canonical reference for "what this
 * importer understands." Keep both sides in sync by hand when either
 * changes.
 */

interface CsvTemplate {
  columns: string[];
  exampleRows: string[][];
}

/** RFC 4180-ish quoting — wraps a field in quotes (doubling any embedded quotes) whenever it contains a comma, quote, or newline; otherwise left bare, matching the style of the hand-written templates this replaces. */
function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function toCsv({ columns, exampleRows }: CsvTemplate): string {
  const lines = [columns.join(','), ...exampleRows.map((row) => row.map(csvField).join(','))];
  return lines.join('\n') + '\n';
}

const EVENT_SESSION_PREFIXES = ['practice', 'qualifying', 'race1', 'race2', 'race3'] as const;

function eventSessionColumns(): string[] {
  const cols: string[] = [];
  for (const prefix of EVENT_SESSION_PREFIXES) {
    cols.push(`${prefix}_start_time`, `${prefix}_sim_time`);
    if (prefix === 'practice' || prefix === 'qualifying') cols.push(`${prefix}_minutes`);
    if (prefix !== 'practice') cols.push(`${prefix}_laps`);
    cols.push(`${prefix}_weather`);
  }
  return cols;
}

const EVENTS_TEMPLATE: CsvTemplate = {
  columns: ['circuit_name', 'layout', 'event_date', 'format', 'fuel_limit_pct', 'results_url', ...eventSessionColumns()],
  exampleRows: [
    [
      'Watkins Glen', 'Full Course', '2026-09-12', 'sprint', '100', 'https://members.iracing.com/',
      '19:00', '14:00', '15', 'clear',
      '19:20', '14:30', '', '10', 'clear',
      '20:00', '15:00', '25', 'clear',
      '', '', '', '',
      '', '', '', '',
    ],
    [
      'Road Atlanta', '', '2026-09-19', 'endurance', '80', '',
      '18:30', '12:00', '20', 'clear',
      '', '', '', '', '',
      '19:00', '13:00', '45', 'clear',
      '', '', '', '',
      '', '', '', '',
    ],
  ],
};

const CIRCUITS_TEMPLATE: CsvTemplate = {
  columns: [
    'name', 'location', 'logo_url', 'layout_name', 'layout_length_km', 'layout_corners',
    'layout_lap_record_seconds', 'layout_lap_record_holder', 'layout_lap_record_date',
  ],
  exampleRows: [
    ['Watkins Glen', 'Watkins Glen, NY', '', 'Full Course', '5.552', '11', '102.512', 'J. Smith', '2026-06-01'],
    ['Road Atlanta', 'Braselton, GA', '', 'Full Course', '4.088', '12', '88.204', '', ''],
  ],
};

const NEWS_TEMPLATE: CsvTemplate = {
  columns: [
    'title', 'slug', 'excerpt', 'body', 'author_name', 'published_date',
    'status', 'season_label', 'round_subsession_id', 'cover_image_url',
  ],
  exampleRows: [
    [
      'Season 18 Kicks Off This Weekend', '', 'A new season, a new set of circuits — here\'s what to watch for.',
      'Full writeup goes here. Multiple sentences are fine, just keep the whole body in one quoted field.',
      'Logan', '2026-09-01', 'published', 'ATC18', '', '',
    ],
    [
      'Mid-Season Standings Update', '', '',
      'Body text for a draft post — this one won\'t show on the public site until its status is changed to published.',
      'Logan', '2026-09-15', 'draft', 'ATC18', '', '',
    ],
  ],
};

// Raw per-driver finish data only — writes to curated_rounds +
// curated_race_results, NOT race_scores. Points are computed separately by
// the scoring engine from a season's Ruleset (Admin > Rulesets) once that
// season has one assigned; this importer's job is getting the raw finish
// data in, not scoring it. class_name is informational only (goes on
// curated_race_results.car_class_name for display) — it isn't a driver_classes
// foreign key.
const RACE_RESULTS_TEMPLATE: CsvTemplate = {
  columns: [
    'import_key', 'circuit_name', 'layout', 'season_name', 'event_date', 'event_time', 'format', 'status',
    'strength_of_field', 'exhibition', 'race_number', 'driver_car_number', 'class_name', 'car_name',
    'finish_position', 'starting_position', 'incidents', 'laps_complete', 'laps_led', 'interval_ten_thousandths',
    'average_lap_time', 'best_lap_time',
  ],
  exampleRows: [
    [
      'exh-2026-08-09-watkinsglen', 'Watkins Glen', 'Full Course', 'ATC18', '2026-08-09', '19:00', 'sprint',
      'official', '1450', 'yes', '1', '4', 'Alpha', 'BMW M4 GT3', '1', '1', '2', '32', '32', '0', '1:42.331',
      '1:41.998',
    ],
    [
      'exh-2026-08-09-watkinsglen', 'Watkins Glen', 'Full Course', 'ATC18', '2026-08-09', '19:00', 'sprint',
      'official', '1450', 'yes', '1', '12', 'Gamma', 'Ferrari 296 GT3', '2', '3', '0', '32', '0', '15230',
      '1:43.010', '1:42.550',
    ],
  ],
};

// Same round-level columns as the race results template (import_key,
// circuit_name, layout, season_name, event_date, event_time, format, status,
// strength_of_field, exhibition) — all three result importers share one
// import_key namespace via manual_result_imports (see
// raceResultsImport.ts's header comment), so uploading a race CSV and a
// qualifying CSV under the same import_key ties both to the same round.
const QUALIFYING_RESULTS_TEMPLATE: CsvTemplate = {
  columns: [
    'import_key', 'circuit_name', 'layout', 'season_name', 'event_date', 'event_time', 'format', 'status',
    'strength_of_field', 'exhibition', 'driver_car_number', 'class_name', 'qual_position', 'best_lap_time',
  ],
  exampleRows: [
    [
      'exh-2026-08-09-watkinsglen', 'Watkins Glen', 'Full Course', 'ATC18', '2026-08-09', '19:00', 'sprint',
      'official', '1450', 'yes', '4', 'Alpha', '1', '1:41.204',
    ],
    [
      'exh-2026-08-09-watkinsglen', 'Watkins Glen', 'Full Course', 'ATC18', '2026-08-09', '19:00', 'sprint',
      'official', '1450', 'yes', '12', 'Gamma', '2', '1:42.018',
    ],
  ],
};

// No finish/qualifying position — a practice session has no ranking, only
// laps run and a best lap (see curated_practice_results's own migration
// header comment, 0078_curated_rounds_event_id_and_practice_results.sql).
const PRACTICE_RESULTS_TEMPLATE: CsvTemplate = {
  columns: [
    'import_key', 'circuit_name', 'layout', 'season_name', 'event_date', 'event_time', 'format', 'status',
    'strength_of_field', 'exhibition', 'driver_car_number', 'class_name', 'laps', 'best_lap_time',
  ],
  exampleRows: [
    [
      'exh-2026-08-09-watkinsglen', 'Watkins Glen', 'Full Course', 'ATC18', '2026-08-09', '19:00', 'sprint',
      'official', '1450', 'yes', '4', 'Alpha', '18', '1:42.550',
    ],
    [
      'exh-2026-08-09-watkinsglen', 'Watkins Glen', 'Full Course', 'ATC18', '2026-08-09', '19:00', 'sprint',
      'official', '1450', 'yes', '12', 'Gamma', '16', '1:43.117',
    ],
  ],
};

export type ImportTemplateKind = 'events' | 'circuits' | 'news' | 'race-results' | 'qualifying-results' | 'practice-results';

const TEMPLATES: Record<ImportTemplateKind, CsvTemplate> = {
  events: EVENTS_TEMPLATE,
  circuits: CIRCUITS_TEMPLATE,
  news: NEWS_TEMPLATE,
  'race-results': RACE_RESULTS_TEMPLATE,
  'qualifying-results': QUALIFYING_RESULTS_TEMPLATE,
  'practice-results': PRACTICE_RESULTS_TEMPLATE,
};

export function getImportTemplateCsv(kind: string): string | null {
  const template = TEMPLATES[kind as ImportTemplateKind];
  return template ? toCsv(template) : null;
}
