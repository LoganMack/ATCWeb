/**
 * CSV templates for the five admin importers, generated from these column lists and served by
 * api/import-templates/[kind].ts, so a column change is made in one place. Importers read columns by header
 * name, so every column an importer reads should be listed here; keep both in sync by hand.
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
  columns: [
    'circuit_name',
    'layout',
    'event_date',
    'format',
    'fuel_limit_pct',
    'results_url',
    ...eventSessionColumns(),
  ],
  exampleRows: [
    [
      'Watkins Glen',
      'Full Course',
      '2026-09-12',
      'sprint',
      '100',
      'https://members.iracing.com/',
      '19:00',
      '14:00',
      '15',
      'clear',
      '19:20',
      '14:30',
      '',
      '10',
      'clear',
      '20:00',
      '15:00',
      '25',
      'clear',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ],
    [
      'Road Atlanta',
      '',
      '2026-09-19',
      'endurance',
      '80',
      '',
      '18:30',
      '12:00',
      '20',
      'clear',
      '',
      '',
      '',
      '',
      '',
      '19:00',
      '13:00',
      '45',
      'clear',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ],
  ],
};

const NEWS_TEMPLATE: CsvTemplate = {
  columns: [
    'title',
    'slug',
    'excerpt',
    'body',
    'author_name',
    'published_date',
    'status',
    'season_label',
    'round_subsession_id',
    'cover_image_url',
  ],
  exampleRows: [
    [
      'Season 18 Kicks Off This Weekend',
      '',
      "A new season, a new set of circuits — here's what to watch for.",
      'Full writeup goes here. Multiple sentences are fine, just keep the whole body in one quoted field.',
      'Logan',
      '2026-09-01',
      'published',
      'ATC18',
      '',
      '',
    ],
    [
      'Mid-Season Standings Update',
      '',
      '',
      "Body text for a draft post — this one won't show on the public site until its status is changed to published.",
      'Logan',
      '2026-09-15',
      'draft',
      'ATC18',
      '',
      '',
    ],
  ],
};

// Raw finish data only, into curated_rounds + curated_race_results; the database scores it once the season
// has a ruleset. class_name is informational (car_class_name), not a driver_classes key.
const RACE_RESULTS_TEMPLATE: CsvTemplate = {
  columns: [
    'import_key',
    'circuit_name',
    'layout',
    'season_name',
    'event_date',
    'event_time',
    'format',
    'strength_of_field',
    'exhibition',
    'test',
    'race_number',
    'driver_car_number',
    'class_name',
    'car_name',
    'finish_position',
    'starting_position',
    'incidents',
    'laps_complete',
    'laps_led',
    'interval_ten_thousandths',
    'average_lap_time',
    'best_lap_time',
  ],
  exampleRows: [
    [
      'exh-2026-08-09-watkinsglen',
      'Watkins Glen',
      'Full Course',
      'ATC18',
      '2026-08-09',
      '19:00',
      'sprint',
      '1450',
      'yes',
      'no',
      '1',
      '4',
      'Alpha',
      'BMW M4 GT3',
      '1',
      '1',
      '2',
      '32',
      '32',
      '0',
      '1:42.331',
      '1:41.998',
    ],
    [
      'exh-2026-08-09-watkinsglen',
      'Watkins Glen',
      'Full Course',
      'ATC18',
      '2026-08-09',
      '19:00',
      'sprint',
      '1450',
      'yes',
      'no',
      '1',
      '12',
      'Gamma',
      'Ferrari 296 GT3',
      '2',
      '3',
      '0',
      '32',
      '0',
      '15230',
      '1:43.010',
      '1:42.550',
    ],
  ],
};

// The same round columns as the race template: the three result importers share one import_key namespace
// (manual_result_imports), so a race CSV and a qualifying CSV with the same key land on the same round.
const QUALIFYING_RESULTS_TEMPLATE: CsvTemplate = {
  columns: [
    'import_key',
    'circuit_name',
    'layout',
    'season_name',
    'event_date',
    'event_time',
    'format',
    'strength_of_field',
    'exhibition',
    'test',
    'driver_car_number',
    'class_name',
    'qual_position',
    'best_lap_time',
  ],
  exampleRows: [
    [
      'exh-2026-08-09-watkinsglen',
      'Watkins Glen',
      'Full Course',
      'ATC18',
      '2026-08-09',
      '19:00',
      'sprint',
      '1450',
      'yes',
      'no',
      '4',
      'Alpha',
      '1',
      '1:41.204',
    ],
    [
      'exh-2026-08-09-watkinsglen',
      'Watkins Glen',
      'Full Course',
      'ATC18',
      '2026-08-09',
      '19:00',
      'sprint',
      '1450',
      'yes',
      'no',
      '12',
      'Gamma',
      '2',
      '1:42.018',
    ],
  ],
};

// No finish/qualifying position — a practice session has no ranking, only
// laps run and a best lap (see curated_practice_results's own migration
// header comment, 0078_curated_rounds_event_id_and_practice_results.sql).
const PRACTICE_RESULTS_TEMPLATE: CsvTemplate = {
  columns: [
    'import_key',
    'circuit_name',
    'layout',
    'season_name',
    'event_date',
    'event_time',
    'format',
    'strength_of_field',
    'exhibition',
    'test',
    'driver_car_number',
    'class_name',
    'laps',
    'best_lap_time',
  ],
  exampleRows: [
    [
      'exh-2026-08-09-watkinsglen',
      'Watkins Glen',
      'Full Course',
      'ATC18',
      '2026-08-09',
      '19:00',
      'sprint',
      '1450',
      'yes',
      'no',
      '4',
      'Alpha',
      '18',
      '1:42.550',
    ],
    [
      'exh-2026-08-09-watkinsglen',
      'Watkins Glen',
      'Full Course',
      'ATC18',
      '2026-08-09',
      '19:00',
      'sprint',
      '1450',
      'yes',
      'no',
      '12',
      'Gamma',
      '16',
      '1:43.117',
    ],
  ],
};

// No circuits template: circuits are changed on Admin > Circuits only, a full-Admin area.
export type ImportTemplateKind =
  'events' | 'news' | 'race-results' | 'qualifying-results' | 'practice-results';

const TEMPLATES: Record<ImportTemplateKind, CsvTemplate> = {
  events: EVENTS_TEMPLATE,
  news: NEWS_TEMPLATE,
  'race-results': RACE_RESULTS_TEMPLATE,
  'qualifying-results': QUALIFYING_RESULTS_TEMPLATE,
  'practice-results': PRACTICE_RESULTS_TEMPLATE,
};

/**
 * Round columns shared by the three results templates, prefilled from the event the template was downloaded
 * for. Keys are real column names, so lookup needs no mapping.
 */
export interface RoundColumnPrefill {
  import_key?: string;
  circuit_name?: string;
  layout?: string;
  season_name?: string;
  event_date?: string;
  event_time?: string;
  format?: string;
  strength_of_field?: string;
  exhibition?: string;
  test?: string;
}

export function getImportTemplateCsv(kind: string, prefill?: RoundColumnPrefill): string | null {
  const template = TEMPLATES[kind as ImportTemplateKind];
  if (!template) return null;
  if (!prefill) return toCsv(template);

  // One starter row: round columns from the event, driver columns left blank for the admin.
  const prefillByColumn = prefill as Record<string, string | undefined>;
  const row = template.columns.map((col) => prefillByColumn[col] ?? '');
  return toCsv({ columns: template.columns, exampleRows: [row] });
}
