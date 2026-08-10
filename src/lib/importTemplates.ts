/**
 * CSV template generation for the 4 admin importers on /admin/import
 * (Events, Circuits, News, Race Results). Templates used to be static files
 * under public/ — the risk with that (and the reason this file exists
 * instead) is that nothing forces a static file to stay in sync with the
 * columns an importer actually reads; it's easy to add/rename a column in
 * the parsing code and forget the template ever existed. Generating the
 * template from the SAME column list documented here, served on demand by
 * src/pages/api/import-templates/[kind].ts, means there's exactly one place
 * to update when an importer's columns change — do that here, and the
 * downloadable template updates itself on the next request, no separate
 * file to remember.
 *
 * Each importer's own parsing code (src/pages/admin/import/index.astro)
 * reads columns by name via `header.indexOf(name)`, not by position, so it
 * doesn't strictly depend on this file at runtime — but every column an
 * importer looks for should have a matching entry here, and this is the
 * canonical reference for "what this importer understands." Keep both
 * sides in sync by hand when either changes.
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
      '19:00', '14:00', '15', 'dry',
      '19:20', '14:30', '', '10', 'dry',
      '20:00', '15:00', '25', 'dry',
      '', '', '', '',
      '', '', '', '',
    ],
    [
      'Road Atlanta', '', '2026-09-19', 'endurance', '80', '',
      '18:30', '12:00', '20', 'dry',
      '', '', '', '', '',
      '19:00', '13:00', '45', 'dry',
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
// driver_name and driver_car_number: at least one identifies the row's
// driver (matched against the Roster) — name lets an admin fill this in
// without knowing everyone's car number by heart; car number is kept for
// CSVs built the old way, before this column existed. If both are given
// they must resolve to the same roster driver, or the row is skipped as a
// data-entry conflict rather than guessing which one is right.
//
// reason_out is optional and mirrors the real iRacing pipeline's own
// values ('Running', 'Disconnected', 'Retired', 'Disqualified',
// 'DQ/Scoring Invalidated') — recalculate_race_scores() reads it to decide
// DSQ (see supabase/migrations/0032_fix_recalculate_race_scores.sql), so
// this is how an exhibition/manual round can flag a DSQ the same way a
// real pipeline import would. Leave it blank for a normal finish.
const RACE_RESULTS_TEMPLATE: CsvTemplate = {
  columns: [
    'import_key', 'circuit_name', 'layout', 'season_name', 'event_date', 'event_time', 'format', 'status',
    'strength_of_field', 'exhibition', 'race_number', 'driver_name', 'driver_car_number', 'class_name', 'car_name',
    'finish_position', 'starting_position', 'incidents', 'laps_complete', 'laps_led', 'interval_ten_thousandths',
    'average_lap_time', 'best_lap_time', 'reason_out',
  ],
  exampleRows: [
    [
      'exh-2026-08-09-watkinsglen', 'Watkins Glen', 'Full Course', 'ATC18', '2026-08-09', '19:00', 'sprint',
      'official', '1450', 'yes', '1', 'Jess Rakowski', '4', 'Alpha', 'BMW M4 GT3', '1', '1', '2', '32', '32', '0',
      '1:42.331', '1:41.998', '',
    ],
    [
      'exh-2026-08-09-watkinsglen', 'Watkins Glen', 'Full Course', 'ATC18', '2026-08-09', '19:00', 'sprint',
      'official', '1450', 'yes', '1', 'Kurt Smith', '12', 'Gamma', 'Ferrari 296 GT3', '2', '3', '0', '32', '0',
      '15230', '1:43.010', '1:42.550', '',
    ],
  ],
};

export type ImportTemplateKind = 'events' | 'circuits' | 'news' | 'race-results';

const TEMPLATES: Record<ImportTemplateKind, CsvTemplate> = {
  events: EVENTS_TEMPLATE,
  circuits: CIRCUITS_TEMPLATE,
  news: NEWS_TEMPLATE,
  'race-results': RACE_RESULTS_TEMPLATE,
};

export function getImportTemplateCsv(kind: string): string | null {
  const template = TEMPLATES[kind as ImportTemplateKind];
  return template ? toCsv(template) : null;
}
