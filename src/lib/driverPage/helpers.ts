import { shortDriverName } from '../db/circuits';
import type { IncidentRow } from '../incidents';
import type { DriverRaceHistoryRow } from '../results/raceHistory';

export interface CareerMove {
  seasonName: string;
  from: string;
  to: string;
  fromLogoUrl: string | null;
  toLogoUrl: string | null;
}

export interface ClassMove {
  seasonName: string;
  from: string;
  to: string;
}

export interface AwardEntry {
  seasonNumber: number;
  seasonName: string;
  label: string;
  detail: string | null;
  /** Set only on a "<Class> Champion" entry — drives the trophy icon shown next to it (see the Awards card template below), tinted via classTextColorClass. Every other award type leaves this null/undefined. */
  className?: string | null;
}
export interface AwardGroup {
  seasonNumber: number;
  seasonName: string;
  awards: AwardEntry[];
}

export function trimNum(n: number, maxDecimals: number): string {
  const str = n.toFixed(maxDecimals);
  return str.includes('.') ? str.replace(/\.?0+$/, '').replace(/\.$/, '') : str;
}
export function signedNum(n: number): string {
  const rounded = Math.round(n);
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

/** Who actually got penalized on this incident — "RI" (Racing Incident) when nobody was at fault. Bolded/brighter when it's THIS profile's own driver (the common case, since most of a driver's own incidents are ones they were penalized on), dimmer when it's someone else and this driver is only tagged as involved. */
export function incidentDriverLabel(row: IncidentRow): string {
  if (!row.driver) return 'RI';
  return row.driver.car_number !== null ? `#${row.driver.car_number} ${shortDriverName(row.driver.name)}` : shortDriverName(row.driver.name);
}

// --- Splits: race history regrouped by Month, Round bucket and Car, with no extra fetch.
// Starts count every row; Wins, Podiums, Top 5s and Avg Finish exclude DSQ rows (their position is only a
// display fallback) but keep unclassified ones.
export interface SplitRow {
  label: string;
  /** Set only on Car-split rows (the car's own logo) — used to show a small logo to the left of the car name in that split's table specifically. Undefined/null for every other split (Month/Round/Team/Layout). */
  logoUrl?: string | null;
  starts: number;
  wins: number;
  podiums: number;
  top5s: number;
  avgFinish: string;
  /** Average of qualPosition/classQualPosition (whichever this row's mode uses) across every race in the group that has one — races 2/3 of a round (no real qualifying, see DriverRaceHistoryRow.qualPosition's own doc comment) simply don't contribute a value, rather than dragging the average down with a fabricated one. "—" when nothing in the group qualified at all. */
  avgQualify: string;
  /** Corners-per-incident for the group — summed totalCorners across every race that resolved one, divided by summed incidents across ALL races in the group (same "sum first, divide once" approach aggregateDriverCareerStats uses for career CPI, rather than averaging each race's own ratio). "—" if no race in the group resolved a corner count, or there were 0 incidents to divide by. */
  cpi: string;
  lapsLed: number;
  points: number;
}
export interface SplitGroup {
  name: string;
  rows: SplitRow[];
}

// Splits rank either by overall running order or by class position; a Gamma/Delta driver's overall order is a
// poor stand-in for their class result. Both row sets are precomputed with the same grouping and the toggle
// switches between them.
export function overallPos(r: DriverRaceHistoryRow): number {
  return r.finishPosition;
}
export function classPos(r: DriverRaceHistoryRow): number {
  return r.classPosition ?? r.finishPosition;
}
export function overallQualPos(r: DriverRaceHistoryRow): number | null {
  return r.qualPosition;
}
export function classQualPos(r: DriverRaceHistoryRow): number | null {
  return r.classQualPosition ?? r.qualPosition;
}

export function buildSplitRows(
  groups: Map<string, DriverRaceHistoryRow[]>,
  posFn: (r: DriverRaceHistoryRow) => number,
  qualPosFn: (r: DriverRaceHistoryRow) => number | null,
  order?: string[]
): SplitRow[] {
  const keys = order ? order.filter((k) => groups.has(k)) : [...groups.keys()];
  return keys.map((label) => {
    const rows = groups.get(label)!;
    const scored = rows.filter((r) => !r.dsq);
    const finishSum = scored.reduce((sum, r) => sum + posFn(r), 0);

    let totalIncidents = 0;
    let totalCorners = 0;
    let anyCornersResolved = false;
    for (const r of rows) {
      totalIncidents += r.incidents ?? 0;
      if (r.totalCorners !== null) {
        totalCorners += r.totalCorners;
        anyCornersResolved = true;
      }
    }

    const qualValues = rows.map(qualPosFn).filter((q): q is number => q !== null);

    return {
      label,
      starts: rows.length,
      wins: scored.filter((r) => posFn(r) === 1).length,
      podiums: scored.filter((r) => posFn(r) <= 3).length,
      top5s: scored.filter((r) => posFn(r) <= 5).length,
      avgFinish: scored.length > 0 ? (finishSum / scored.length).toFixed(1) : '—',
      avgQualify: qualValues.length > 0 ? (qualValues.reduce((a, b) => a + b, 0) / qualValues.length).toFixed(1) : '—',
      cpi: anyCornersResolved && totalIncidents > 0 ? (totalCorners / totalIncidents).toFixed(1) : '—',
      lapsLed: rows.reduce((sum, r) => sum + (r.lapsLed ?? 0), 0),
      points: rows.reduce((sum, r) => sum + r.totalPoints, 0),
    };
  });
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Rounds without a display number (exhibition/test) can't be bucketed and are left out.
export const ROUND_BUCKETS = ['Rounds 1–3', 'Rounds 4–6', 'Rounds 7–9', 'Rounds 10+'];
export function roundBucketLabel(n: number): string {
  if (n <= 3) return ROUND_BUCKETS[0];
  if (n <= 6) return ROUND_BUCKETS[1];
  if (n <= 9) return ROUND_BUCKETS[2];
  return ROUND_BUCKETS[3];
}

// Initial alphabetical order for splits with no natural order; every column is also click-to-sort.
export function buildUnorderedRows(
  groups: Map<string, DriverRaceHistoryRow[]>,
  posFn: (r: DriverRaceHistoryRow) => number,
  qualPosFn: (r: DriverRaceHistoryRow) => number | null
): SplitRow[] {
  return buildSplitRows(groups, posFn, qualPosFn).sort((a, b) => a.label.localeCompare(b.label));
}

export interface LayoutBestRow {
  trackName: string;
  /** Already run through displayLayoutName (so the "N/A" single-configuration sentinel reads as "Full Course") — "—" when this track's rounds have never had a layout value on file at all. */
  layoutText: string;
  personalBestTenThousandths: number | null;
  personalBestFormatted: string;
  trackRecordSeconds: number | null;
  trackRecordFormatted: string;
}
