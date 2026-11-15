import { formatLapTime, displayLayoutName } from '../db/circuits';
import type { DriverRaceHistoryRow } from '../results/raceHistory';
import {
  classTrackRecord,
  combineOverallRecord,
  leagueRecord,
  type LeagueRecords,
  type TrackRecord,
} from '../results/trackRecords';
import { bestsDelta } from './bestsDelta';
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
  type BestsFilterCell,
  type LayoutBestRow,
  type SplitGroup,
  type SplitRow,
} from './helpers';

/** What the Bests tab needs to show computed records (W5): the league records and the Gamma and Delta ids. */
export interface BestsRecordInputs {
  league: LeagueRecords;
  /** Found by class name; null when the class is missing, so its records all show "—" (BR2.3). */
  gammaClassId: number | null;
  deltaClassId: number | null;
  /** Roster driver id -> shown name, for league record holders (BR1.5). */
  driverNameById?: ReadonlyMap<string, string>;
}

function bestsCell(record: TrackRecord | null, personalBestTenThousandths: number | null): BestsFilterCell {
  const delta = bestsDelta({ personalBestTenThousandths, trackRecordSeconds: record?.seconds ?? null });
  return {
    recordSeconds: record?.seconds ?? null,
    recordFormatted: record?.formatted ?? formatLapTime(null),
    holder: record?.holderName ?? null,
    date: record?.date ?? null,
    holdsRecord: delta.holdsRecord,
    deltaText: delta.text,
    deltaSortValue: delta.sortValue,
  };
}

/** The driver profile fragment's derived views (award groups, splits, bests), built from loadDriverPage's data without further fetches. */
export function buildDriverPageGroups(
  raceHistory: DriverRaceHistoryRow[],
  awardEntries: AwardEntry[],
  /** The league records; without them the Bests tab shows the typed records only. */
  records: BestsRecordInputs | null = null,
) {
  // Awards are grouped by season; awardEntries is sorted newest first, so this is a run-length pass.
  const awardGroups: AwardGroup[] = [];
  for (const a of awardEntries) {
    const last = awardGroups[awardGroups.length - 1];
    if (last && last.seasonNumber === a.seasonNumber && last.seasonName === a.seasonName) {
      last.awards.push(a);
    } else {
      awardGroups.push({ seasonNumber: a.seasonNumber, seasonName: a.seasonName, awards: [a] });
    }
  }

  // Races per subsession for this driver: rounds with more than one race get a "(Race N)" suffix on every
  // race.
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

  // Team split by the team raced for in each race (race_score_results.team_id), not the season roster; no
  // team counts as "Independent".
  const teamGroups = new Map<string, DriverRaceHistoryRow[]>();
  for (const r of raceHistory) {
    const label = r.team?.name ?? 'Independent';
    if (!teamGroups.has(label)) teamGroups.set(label, []);
    teamGroups.get(label)!.push(r);
  }

  // Layout split by layoutLabel, so a track's configurations (Monza "Grand Prix" vs "Junior") stay apart.
  const layoutGroups = new Map<string, DriverRaceHistoryRow[]>();
  for (const r of raceHistory) {
    const label = r.layoutLabel;
    if (!layoutGroups.has(label)) layoutGroups.set(label, []);
    layoutGroups.get(label)!.push(r);
  }

  // Car split rows additionally carry the car's own logo, for the small logo
  // shown to the left of the car name in that split specifically.
  function buildCarRows(
    posFn: (r: DriverRaceHistoryRow) => number,
    qualPosFn: (r: DriverRaceHistoryRow) => number | null,
  ): SplitRow[] {
    return buildUnorderedRows(carGroups, posFn, qualPosFn).map((row) => ({
      ...row,
      logoUrl: carGroups.get(row.label)?.[0]?.car?.logoUrl ?? null,
    }));
  }

  // Team split rows carry the team's logo the same way (FR5), from the first of its races that has one;
  // "Independent" has none.
  function buildTeamRows(
    posFn: (r: DriverRaceHistoryRow) => number,
    qualPosFn: (r: DriverRaceHistoryRow) => number | null,
  ): SplitRow[] {
    return buildUnorderedRows(teamGroups, posFn, qualPosFn).map((row) => ({
      ...row,
      logoUrl: teamGroups.get(row.label)?.find((r) => r.team?.logoUrl)?.team?.logoUrl ?? null,
    }));
  }

  const splitGroupsOverall: SplitGroup[] = [
    { name: 'Month', rows: buildSplitRows(monthGroups, overallPos, overallQualPos, MONTH_NAMES) },
    { name: 'Round', rows: buildSplitRows(roundGroups, overallPos, overallQualPos, ROUND_BUCKETS) },
    { name: 'Car', rows: buildCarRows(overallPos, overallQualPos) },
    { name: 'Team', rows: buildTeamRows(overallPos, overallQualPos) },
    { name: 'Layout', rows: buildUnorderedRows(layoutGroups, overallPos, overallQualPos) },
  ];
  const splitGroupsClass: SplitGroup[] = [
    { name: 'Month', rows: buildSplitRows(monthGroups, classPos, classQualPos, MONTH_NAMES) },
    { name: 'Round', rows: buildSplitRows(roundGroups, classPos, classQualPos, ROUND_BUCKETS) },
    { name: 'Car', rows: buildCarRows(classPos, classQualPos) },
    { name: 'Team', rows: buildTeamRows(classPos, classQualPos) },
    { name: 'Layout', rows: buildUnorderedRows(layoutGroups, classPos, classQualPos) },
  ];

  // --- Bests: one row per layout (the same grouping as the Layout split), the driver's fastest lap there
  // against the record under each filter (W5).
  // Personal Best counts every race in any class, DSQ and unclassified included: a lap time is a timing fact
  // (BR2.1). The layout key and typed record are the same for every race in a group, so they're read from the
  // first row.
  const league: LeagueRecords = records?.league ?? new Map();
  const layoutBests: LayoutBestRow[] = [...layoutGroups.entries()]
    .map(([, rows]) => {
      const bestTimes = rows.map((r) => r.bestLapTenThousandths).filter((t): t is number => t !== null);
      const personalBestTenThousandths = bestTimes.length > 0 ? Math.min(...bestTimes) : null;
      const key = rows[0].recordKey ?? null;
      const typed = {
        lap_record_seconds: rows[0].layoutRecordSeconds,
        lap_record_holder: rows[0].layoutRecordHolder ?? null,
        lap_record_date: rows[0].layoutRecordDate ?? null,
      };
      const names = records?.driverNameById;
      const classRecord = (classId: number | null | undefined) =>
        classId == null ? null : classTrackRecord(leagueRecord(league, key, classId), names);
      return {
        trackName: rows[0].trackName,
        layoutText: rows[0].roundLayoutText ? displayLayoutName(rows[0].roundLayoutText) : '—',
        personalBestTenThousandths,
        personalBestFormatted: formatLapTime(
          personalBestTenThousandths !== null ? personalBestTenThousandths / 10000 : null,
        ),
        byFilter: {
          overall: bestsCell(
            combineOverallRecord(typed, leagueRecord(league, key, 'overall'), names),
            personalBestTenThousandths,
          ),
          gamma: bestsCell(classRecord(records?.gammaClassId), personalBestTenThousandths),
          delta: bestsCell(classRecord(records?.deltaClassId), personalBestTenThousandths),
        },
      };
    })
    .sort((a, b) => a.trackName.localeCompare(b.trackName) || a.layoutText.localeCompare(b.layoutText));
  return { awardGroups, raceCountBySubsession, splitGroupsOverall, splitGroupsClass, layoutBests };
}
