/**
 * Labels for the incident tables, shared by History → Incidents and the Event Briefing's Past Incidents,
 * which use the same table and details popup.
 */
import { displayDriverName, shortDriverName, formatDateShort } from './db/circuits';
import type { IncidentRow } from './incidents';

export function sessionLabel(row: IncidentRow): string {
  if (row.sessionType === 'qualifying') return 'Qualifying';
  if (row.sessionType === 'practice') return 'Practice';
  return `Race ${row.raceNumber}`;
}

export function roundLabel(row: IncidentRow): string {
  return row.displayRoundNumber !== null ? `Round ${row.displayRoundNumber}` : 'Exhibition';
}

/** Driver column, collapsed to just the car number (or a short name when there's no number on file, or "RI" for a driverless Racing Incident entry) — the full name is revealed on hover instead (see that cell's `title` attribute), per Logan: "hide the driver name and only display the number." */
export function driverNumberLabel(row: IncidentRow): string {
  if (!row.driver) return 'RI';
  return row.driver.car_number !== null ? `#${row.driver.car_number}` : shortDriverName(row.driver.name);
}

/** Track names longer than this are cut short with an ellipsis in the All Incidents table (the full name shows on hover). */
const TRACK_MAX_CHARS = 20;
export function shortTrackName(name: string): string {
  return name.length > TRACK_MAX_CHARS ? `${name.slice(0, TRACK_MAX_CHARS).trimEnd()}…` : name;
}

export function involvedLabel(row: IncidentRow): string {
  if (row.involvedDrivers.length === 0) return '—';
  return row.involvedDrivers
    .map((d) => (d.car_number !== null ? `#${d.car_number}` : shortDriverName(d.name)))
    .join(', ');
}

/** Everything the click-to-open "Incident Details" popup shows, keyed by incident id and embedded once as JSON (the same incident can appear in several tables, so it isn't repeated per row). */
export function incidentSummary(row: IncidentRow) {
  return {
    driver:
      row.driver === null
        ? 'Racing Incident (no driver at fault)'
        : `${row.driver.car_number !== null ? `#${row.driver.car_number} ` : ''}${displayDriverName(row.driver.name)}`,
    season: row.seasonLabel ?? '—',
    round: roundLabel(row),
    track: row.trackName,
    date: formatDateShort(row.startTime),
    session: sessionLabel(row),
    incidentNumber: row.incidentNumber
      ? row.incidentNumber.startsWith('#')
        ? row.incidentNumber
        : `#${row.incidentNumber}`
      : '—',
    lap: row.lap,
    involved: row.involvedDrivers.map(
      (d) => `${d.car_number !== null ? `#${d.car_number} ` : ''}${shortDriverName(d.name)}`,
    ),
    description: row.description,
    offenses: row.offenseNames,
    isWarning: row.isWarning,
    pp: row.penaltyPoints,
    time: row.timePenaltySeconds,
    points: row.pointsPenalty,
    isAppealed: row.isAppealed,
    href: `/results/${row.subsessionId}/incidents`,
    roundHref: `/results/${row.subsessionId}`,
  };
}

/** The popup's JSON block contents. "<" is escaped so a description can never close the <script> tag early. */
export function incidentSummariesJson(rows: IncidentRow[]): string {
  const summaries: Record<string, ReturnType<typeof incidentSummary>> = {};
  for (const row of rows) summaries[row.id] = incidentSummary(row);
  return JSON.stringify(summaries).replace(/</g, '\\u003c');
}
