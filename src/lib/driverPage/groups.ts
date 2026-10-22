import { formatLapTime, displayLayoutName } from '../db/circuits';
import type { DriverRaceHistoryRow } from '../results/raceHistory';
import {
  overallPos,
  classPos,
  overallQualPos,
  classQualPos,
  buildSplitRows,
  MONTH_NAMES,
  ROUND_BUCKETS,
  roundBucketLabel,
  buildUnorderedRows,
  type AwardEntry,
  type AwardGroup,
  type LayoutBestRow,
  type SplitGroup,
  type SplitRow,
} from './helpers';

/** The driver profile fragment's derived views (award groups, splits, bests), built from loadDriverPage's data without further fetches. */
export function buildDriverPageGroups(raceHistory: DriverRaceHistoryRow[], awardEntries: AwardEntry[]) {
  // Awards are displayed grouped by season (one heading per season, its
  // awards listed underneath) rather than repeating the season name on every
  // row. awardEntries is already sorted newest-season-first, so grouping is
  // just a run-length pass over consecutive matching seasonNumber/seasonName.
  const awardGroups: AwardGroup[] = [];
  for (const a of awardEntries) {
    const last = awardGroups[awardGroups.length - 1];
    if (last && last.seasonNumber === a.seasonNumber && last.seasonName === a.seasonName) {
      last.awards.push(a);
    } else {
      awardGroups.push({ seasonNumber: a.seasonNumber, seasonName: a.seasonName, awards: [a] });
    }
  }

  // How many of THIS driver's own races share a subsession_id — a round with
  // more than one counts as a multi-race (sprint) round for them, so every
  // race in it (including race 1) gets its own "(Race N)" suffix in the
  // Races table below; a round where they only have one row shows just the
  // round number, nothing to disambiguate.
  const raceCountBySubsession = new Map<number, number>();
  for (const r of raceHistory) {
    raceCountBySubsession.set(r.subsessionId, (raceCountBySubsession.get(r.subsessionId) ?? 0) + 1);
  }

  const monthGroups = new Map<string, DriverRaceHistoryRow[]>();
  for (const r of raceHistory) {
    if (!r.startTime) continue;
    const label = MONTH_NAMES[new Date(r.startTime).getUTCMonth()];
    if (!monthGroups.has(label)) monthGroups.set(label, []);
    monthGroups.get(label)!.push(r);
  }

  const roundGroups = new Map<string, DriverRaceHistoryRow[]>();
  for (const r of raceHistory) {
    if (r.displayRoundNumber === null) continue;
    const label = roundBucketLabel(r.displayRoundNumber);
    if (!roundGroups.has(label)) roundGroups.set(label, []);
    roundGroups.get(label)!.push(r);
  }

  const carGroups = new Map<string, DriverRaceHistoryRow[]>();
  for (const r of raceHistory) {
    const label = r.car?.name ?? 'Unknown';
    if (!carGroups.has(label)) carGroups.set(label, []);
    carGroups.get(label)!.push(r);
  }

  // Team split — grouped by the team this driver raced FOR in each individual
  // race (race_score_results.team_id, same per-race provenance DriverRaceHistoryRow.
  // team already carries), not by season-roster membership. A race with no
  // team assigned counts as "Independent" rather than being dropped, per the
  // request that time spent as an independent get its own row.
  const teamGroups = new Map<string, DriverRaceHistoryRow[]>();
  for (const r of raceHistory) {
    const label = r.team?.name ?? 'Independent';
    if (!teamGroups.has(label)) teamGroups.set(label, []);
    teamGroups.get(label)!.push(r);
  }

  // Layout split — grouped by DriverRaceHistoryRow.layoutLabel (trackName plus
  // this round's specific circuit_layouts configuration when curated_rounds.
  // layout resolves one), so e.g. Monza's "Grand Prix" and "Junior" configs
  // don't get lumped into one Monza row the way a plain track-name split would.
  const layoutGroups = new Map<string, DriverRaceHistoryRow[]>();
  for (const r of raceHistory) {
    const label = r.layoutLabel;
    if (!layoutGroups.has(label)) layoutGroups.set(label, []);
    layoutGroups.get(label)!.push(r);
  }

  // Car split rows additionally carry the car's own logo, for the small logo
  // shown to the left of the car name in that split specifically.
  function buildCarRows(posFn: (r: DriverRaceHistoryRow) => number, qualPosFn: (r: DriverRaceHistoryRow) => number | null): SplitRow[] {
    return buildUnorderedRows(carGroups, posFn, qualPosFn).map((row) => ({
      ...row,
      logoUrl: carGroups.get(row.label)?.[0]?.car?.logoUrl ?? null,
    }));
  }

  const splitGroupsOverall: SplitGroup[] = [
    { name: 'Month', rows: buildSplitRows(monthGroups, overallPos, overallQualPos, MONTH_NAMES) },
    { name: 'Round', rows: buildSplitRows(roundGroups, overallPos, overallQualPos, ROUND_BUCKETS) },
    { name: 'Car', rows: buildCarRows(overallPos, overallQualPos) },
    { name: 'Team', rows: buildUnorderedRows(teamGroups, overallPos, overallQualPos) },
    { name: 'Layout', rows: buildUnorderedRows(layoutGroups, overallPos, overallQualPos) },
  ];
  const splitGroupsClass: SplitGroup[] = [
    { name: 'Month', rows: buildSplitRows(monthGroups, classPos, classQualPos, MONTH_NAMES) },
    { name: 'Round', rows: buildSplitRows(roundGroups, classPos, classQualPos, ROUND_BUCKETS) },
    { name: 'Car', rows: buildCarRows(classPos, classQualPos) },
    { name: 'Team', rows: buildUnorderedRows(teamGroups, classPos, classQualPos) },
    { name: 'Layout', rows: buildUnorderedRows(layoutGroups, classPos, classQualPos) },
  ];

  // --- Bests: one row per layout this driver has ever raced (same layoutGroups
  // grouping the Splits card's own Layout split uses above, so the two stay
  // consistent about what counts as "one layout"), with this driver's own
  // fastest lap there against the site's curated Track Record for that layout.
  // Personal Best is the MINIMUM bestLapTenThousandths across every race in
  // the group (DSQ'd/unclassified races still count — a lap time is a raw
  // timing fact independent of classification, same reasoning
  // getDriverBestLapsAtTrack/getLayoutClassBestLaps use). Track Record is the
  // same circuit_layouts.lap_record_seconds figure shown on the Circuits and
  // Event Briefing pages (results.ts resolves it once per race already, via
  // the same resolveLayout() call totalCorners uses — see
  // DriverRaceHistoryRow.layoutRecordSeconds' own doc comment), so it's
  // identical across every race in a group; read off the first row rather
  // than re-resolved here.
  const layoutBests: LayoutBestRow[] = [...layoutGroups.entries()]
    .map(([, rows]) => {
      const bestTimes = rows.map((r) => r.bestLapTenThousandths).filter((t): t is number => t !== null);
      const personalBestTenThousandths = bestTimes.length > 0 ? Math.min(...bestTimes) : null;
      return {
        trackName: rows[0].trackName,
        layoutText: rows[0].roundLayoutText ? displayLayoutName(rows[0].roundLayoutText) : '—',
        personalBestTenThousandths,
        personalBestFormatted: formatLapTime(personalBestTenThousandths !== null ? personalBestTenThousandths / 10000 : null),
        trackRecordSeconds: rows[0].layoutRecordSeconds,
        trackRecordFormatted: formatLapTime(rows[0].layoutRecordSeconds),
      };
    })
    .sort((a, b) => a.trackName.localeCompare(b.trackName) || a.layoutText.localeCompare(b.layoutText));
  return { awardGroups, raceCountBySubsession, splitGroupsOverall, splitGroupsClass, layoutBests };
}
