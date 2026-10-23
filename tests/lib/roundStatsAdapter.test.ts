/**
 * The stored-stats adapter (BR1.1, BR2.1-BR2.3) against today's per-race builders on ATC17. The stored
 * rows come from tests/golden/roundRows.ts, which derives them from the golden inputs with U2's SQL rules,
 * so nothing here is circular: the adapter must reproduce the golden standings (expected.json, with the
 * owner's DECIDED totals), every "as of round N" slider array, the denominators and the team standings.
 * A mismatch is a finding; expected.json is never edited to make this pass.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DECIDED,
  buildContext,
  exhibitionIds,
  expected,
  inputs,
  poolFor,
  scores,
  season,
  standingsFor,
  wanted,
  type GoldenRow,
} from '../golden/atc17';
import { perRoundFromRaceRows } from '../golden/roundRows';
import viewRows from '../fixtures/golden/atc17/view-rows.json';
import { toPenalty, type Penalty } from '../../src/lib/db/penalties';
import type { SupabaseEnv } from '../../src/lib/db/client';
import type { Circuit, CircuitLayout } from '../../src/lib/db/circuits';
import { buildSeasonOverallContext, type SeasonOverallContext } from '../../src/lib/results/seasonContext';
import type { RoundWithLayout } from '../../src/lib/results/rounds';
import type { TeamBasic } from '../../src/lib/results/rows';
import {
  carTeamStatsFromRounds,
  classStandingsFromRounds,
  extendedStatsFromRounds,
  overallStandingsFromRounds,
  seasonDenominators,
  seasonRoundStatsFrom,
  teamStandingsFromRounds,
  viewSubsessionIds,
  type SeasonRoundStats,
} from '../../src/lib/results/roundStatsAdapter';
import { loadDriverStandingsView } from '../../src/lib/results/standingsView';
import {
  getSeasonDriverExtendedStats,
  type DriverSeasonExtendedStats,
} from '../../src/lib/results/extendedStats';
import { computeTeamSeasonStandings, type TeamSeasonStanding } from '../../src/lib/results/teamStandings';
import { getSeasonCarTeamStats } from '../../src/lib/results/seasonCarTeam';
import { buildOverallSeasonStandings, buildSeasonStandings } from '../../src/lib/results/standings';
import {
  MIN_ROUNDS_FOR_DROPS,
  computeSeasonStandingsRoundColumns,
  seasonDropWeeks,
  type DriverSeasonStanding,
  type SeasonStandingsRoundColumn,
} from '../../src/lib/results/standingsCore';
import { resolveSeasonRuleset } from '../../src/lib/db/seasons';
import { totalAsOf } from '../../src/lib/seasonTotals';
import type { RoundDriverStatsRow } from '../../src/lib/db/roundStats';

const blocked = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = blocked;
});

const penalties: Penalty[] = inputs.penalties.map(toPenalty);
const allRoundIds = new Set(scores.map((s) => s.subsession_id));
const stored = perRoundFromRaceRows({
  scores,
  rawResults: inputs.rawResults,
  drivers: inputs.drivers,
  penalties,
  classes: inputs.classes,
  // Every ATC17 round was posted when it was captured.
  postedIds: allRoundIds,
});
const rounds: RoundWithLayout[] = inputs.seasonRounds.map((r) => ({ ...r, layout: null }));
const stats = seasonRoundStatsFrom(season, rounds, exhibitionIds, stored);
const refs = { drivers: inputs.drivers, rulesets: inputs.rulesets, classes: inputs.classes, penalties };

// One circuit and layout per track, so km and corners resolve: each track gets its own length and count.
const circuits: Circuit[] = [...new Set(rounds.map((r) => r.track_name))].map((name, i) => ({
  id: `c${i}`,
  name,
  logo_url: null,
  location: null,
}));
const layouts: CircuitLayout[] = circuits.map((c, i) => ({
  id: `l${i}`,
  circuit_id: c.id,
  name: 'Full',
  length_km: 3.215 + i * 0.437,
  lap_record_seconds: null,
  lap_record_holder: null,
  lap_record_date: null,
  image_url: null,
  corners: 9 + i,
}));
const teams: TeamBasic[] = [
  ...new Set(scores.map((s) => s.team_id).filter((t): t is string => t !== null)),
].map((id) => ({ id, name: `Team ${id.slice(0, 8)}`, logo_url: null }));
const noEnv = { url: '', anonKey: '' } as SupabaseEnv;
const views = [
  { name: 'overall', classId: null as number | null },
  ...inputs.classes.map((c) => ({ name: c.name, classId: c.id })),
];

function storedStandings(classId: number | null, s: SeasonRoundStats = stats): DriverSeasonStanding[] {
  return classId === null ? overallStandingsFromRounds(s, refs) : classStandingsFromRounds(s, classId, refs);
}

const rowsOf = (standings: DriverSeasonStanding[]): GoldenRow[] =>
  standings.map((s) => ({ position: s.position, driverId: s.driver.id, total: s.totalPoints }));

/** The page's per-driver slider array (driverRoundsJson) and penalty array (driverPenaltyJson). */
function sliderArrays(
  standings: DriverSeasonStanding[],
  ext: Map<string, DriverSeasonExtendedStats>,
  columns: SeasonStandingsRoundColumn[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of standings) {
    const e = ext.get(row.driver.id);
    out[row.driver.id] = {
      rounds: columns.map((col) => {
        const cell = row.roundCells.get(col.subsessionId);
        if (!cell) return null;
        const st = row.roundStats.get(col.subsessionId);
        const ex = e?.byRound.get(col.subsessionId);
        return [
          cell.points,
          cell.dropped,
          cell.penalties,
          st,
          ex?.laps ?? 0,
          ex?.lapsLed ?? 0,
          ex?.netPositionsChange ?? 0,
          ex?.incidents ?? 0,
          ex?.bonusPoints ?? 0,
          ex && ex.km !== null ? ex.laps * ex.km : null,
          ex && ex.corners !== null ? ex.laps * ex.corners : null,
        ];
      }),
      penalties: columns.map((col) => e?.byRound.get(col.subsessionId)?.penaltyPoints ?? 0),
      starts: row.starts,
      appearances: row.appearances,
      classId: row.classId,
    };
  }
  return out;
}

async function liveExtended(context: SeasonOverallContext) {
  return getSeasonDriverExtendedStats(
    noEnv,
    season,
    exhibitionIds,
    inputs.drivers,
    context,
    circuits,
    layouts,
    new Map(),
  );
}

/** Comparable team standings: everything but the per-race entries, which only the live Teams view lists. */
function teamRows(rows: TeamSeasonStanding[]) {
  return rows.map(({ raceEntries: _entries, driverIds, ...rest }) => ({
    ...rest,
    driverIds: [...driverIds].sort(),
  }));
}

describe('round stats adapter on ATC17', () => {
  it('reproduces the golden standings in the overall view and every class view', () => {
    expect(Object.keys(expected.views).sort()).toEqual(['Alpha', 'Delta', 'Gamma', 'overall']);
    const differences: string[] = [];
    for (const [name, view] of Object.entries(expected.views)) {
      const actual = rowsOf(storedStandings(view.classId));
      const want = view.rows.map((r) => wanted(name, r));
      expect(actual.length, name).toBe(want.length);
      want.forEach((w, i) => {
        if (JSON.stringify(w) !== JSON.stringify(actual[i])) {
          differences.push(
            `${name} row ${i + 1}: expected ${JSON.stringify(w)}, got ${JSON.stringify(actual[i])}`,
          );
        }
      });
    }
    expect(differences).toEqual([]);
    expect(Object.keys(DECIDED).length).toBeGreaterThan(0);
  });

  it('gives the slider the same arrays and the same totals as today for every round of every view', async () => {
    const context = buildContext();
    const live = await liveExtended(context);
    const storedExt = extendedStatsFromRounds(stats, { circuits, layouts });
    // The season totals behind the standings panel too, not only the per-round figures.
    expect(Object.fromEntries(storedExt)).toEqual(Object.fromEntries(live));

    const drops = seasonDropWeeks(season, inputs.rulesets);
    const canDropFinal = resolveSeasonRuleset(season, inputs.rulesets)?.can_drop_final_round ?? false;
    let compared = 0;
    for (const { name, classId } of views) {
      const liveColumns = computeSeasonStandingsRoundColumns(
        context.seasonRounds,
        poolFor(classId, context),
        new Map(),
      );
      const storedColumns = computeSeasonStandingsRoundColumns(
        stats.rounds,
        viewSubsessionIds(stats, classId ?? undefined),
        new Map(),
      );
      expect(storedColumns, name).toEqual(liveColumns);
      const liveStandings = standingsFor(classId, context);
      const ours = storedStandings(classId);
      expect(sliderArrays(ours, storedExt, storedColumns), name).toEqual(
        sliderArrays(liveStandings, live, liveColumns),
      );
      for (let n = 1; n <= liveColumns.length; n++) {
        const totals = (standings: DriverSeasonStanding[]) =>
          standings.map((s) => [
            s.driver.id,
            totalAsOf(
              liveColumns.map((c) => s.roundCells.get(c.subsessionId)?.points ?? null),
              n,
              drops,
              MIN_ROUNDS_FOR_DROPS,
              canDropFinal,
            ).total,
          ]);
        expect(totals(ours), `${name} as of round ${n}`).toEqual(totals(liveStandings));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(20);
  });

  it('derives the same Starts and Apps denominators as today', () => {
    const context = buildContext();
    for (const { name, classId } of views) {
      const columns = computeSeasonStandingsRoundColumns(
        context.seasonRounds,
        poolFor(classId, context),
        new Map(),
      );
      // Today's page code: distinct races and rounds of the whole season, as of each column.
      const startTime = new Map(context.seasonRounds.map((r) => [r.subsession_id, r.start_time]));
      const races = new Map<number, Set<number>>();
      for (const s of context.overallScores) {
        if (!races.has(s.subsession_id)) races.set(s.subsession_id, new Set());
        races.get(s.subsession_id)!.add(s.race_number);
      }
      const list = [...races].map(([id, r]) => ({ t: startTime.get(id) ?? '', races: r.size }));
      const today = {
        maxStarts: new Set(context.overallScores.map((s) => `${s.subsession_id}:${s.race_number}`)).size,
        maxAppearances: races.size,
        colDenoms: columns.map((col) => {
          const through = list.filter((r) => r.t <= col.startTime);
          return { s: through.reduce((sum, r) => sum + r.races, 0), a: through.length };
        }),
      };
      expect(seasonDenominators(stats, columns), name).toEqual(today);
    }
  });

  it('builds the same team standings and car and team usage as today', async () => {
    const context = buildContext();
    const alpha = inputs.classes.find((c) => c.name === 'Alpha')!.id;
    const delta = inputs.classes.find((c) => c.name === 'Delta')!.id;
    for (const classId of [undefined, alpha, delta]) {
      const live = await computeTeamSeasonStandings(
        noEnv,
        season,
        exhibitionIds,
        classId,
        inputs.drivers,
        teams,
        [],
        inputs.classes,
        context,
        classId !== undefined ? scores.filter((s) => s.class_id === classId) : undefined,
      );
      const ours = teamStandingsFromRounds(stats, classId, { teams, seasonLogoRows: [], penalties });
      expect(live.length, `competition ${classId ?? 'overall'}`).toBeGreaterThan(0);
      expect(teamRows(ours), `competition ${classId ?? 'overall'}`).toEqual(teamRows(live));
    }

    const liveExtras = await getSeasonCarTeamStats(
      noEnv,
      season,
      exhibitionIds,
      inputs.drivers,
      teams,
      [],
      [],
      context,
    );
    const ourExtras = carTeamStatsFromRounds(stats, { teams, carLogos: [], seasonLogoRows: [] });
    const usage = (m: typeof liveExtras) =>
      Object.fromEntries(
        [...m].map(([id, e]) => [
          id,
          {
            cars: Object.fromEntries(e.cars.map((c) => [c.carName, c.races])),
            teams: Object.fromEntries(e.teams.map((t) => [t.teamId, t.racesUnderTeam])),
            primary: e.teams[0]?.teamId ?? null,
          },
        ]),
      );
    expect(usage(ourExtras)).toEqual(usage(liveExtras));

    // Races scored for the team: equal except where a team's 2nd and 3rd finishers of a race tie on points.
    // U2's SQL breaks that tie by shown position then driver_id, today's code by fetch order (U2 addendum:
    // listed for the owner to accept). ATC17 has two such races, both 0-point ties; this pins them.
    const scored = (m: typeof liveExtras) =>
      new Map(
        [...m].flatMap(([id, e]) => e.teams.map((t) => [`${id}:${t.teamId}`, t.racesScoredForTeam] as const)),
      );
    const ours = scored(ourExtras);
    const today = scored(liveExtras);
    const tiedDrivers = new Set<string>();
    const byRaceTeam = new Map<string, typeof scores>();
    for (const s of scores) {
      if (!s.team_id || exhibitionIds.has(s.subsession_id)) continue;
      const key = `${s.subsession_id}:${s.race_number}:${s.team_id}`;
      byRaceTeam.set(key, [...(byRaceTeam.get(key) ?? []), s]);
    }
    for (const group of byRaceTeam.values()) {
      const points = group.map((s) => s.overall_total).sort((a, b) => b - a);
      if (group.length < 3 || points[1] !== points[2]) continue;
      for (const s of group) if (s.overall_total === points[1]) tiedDrivers.add(s.driver_id);
    }
    const differing = [...today].filter(([key, n]) => ours.get(key) !== n).map(([key]) => key.split(':')[0]);
    expect(tiedDrivers.size).toBe(5);
    expect(differing).toHaveLength(4);
    for (const driverId of differing) expect(tiedDrivers.has(driverId), driverId).toBe(true);
    // Each tie moves one scored race between two teammates, so every team's total is unchanged.
    const byTeam = (m: Map<string, number>) => {
      const out = new Map<string, number>();
      for (const [key, n] of m) out.set(key.split(':')[1], (out.get(key.split(':')[1]) ?? 0) + n);
      return out;
    };
    expect(byTeam(ours)).toEqual(byTeam(today));
  });

  it("adds a penalty-only driver's points without giving them a standings row", async () => {
    const lastRound = Math.max(...stats.driverRows.map((r) => r.subsession_id));
    const racing = new Set(scores.map((s) => s.driver_id));
    const absent = inputs.drivers.find((d) => !racing.has(d.id))!;
    const extra: Penalty = {
      ...penalties[0],
      id: 'pp-only',
      subsession_id: lastRound,
      driver_id: absent.id,
      penalty_points: 3,
      is_appealed: false,
    };
    const withPenalty = seasonRoundStatsFrom(season, rounds, exhibitionIds, {
      ...stored,
      penaltyRows: [
        ...stored.penaltyRows,
        { subsession_id: lastRound, driver_id: absent.id, season_id: season.id, penalty_points: 3 },
      ],
    });
    const ours = extendedStatsFromRounds(withPenalty, { circuits, layouts }).get(absent.id);
    expect(ours?.penaltyPoints).toBe(3);
    expect(ours?.byRound.get(lastRound)?.penaltyPoints).toBe(3);
    expect(ours?.laps).toBe(0);

    const context = buildSeasonOverallContext(
      exhibitionIds,
      inputs.drivers,
      scores,
      inputs.rawResults,
      [...penalties, extra],
      inputs.seasonRounds,
      inputs.lapStats,
    );
    expect(ours).toEqual((await liveExtended(context)).get(absent.id));
    expect(storedStandings(null, withPenalty).some((s) => s.driver.id === absent.id)).toBe(false);
  });

  it('leaves a hidden round out of the pool, the drops and the Matrix, as today', () => {
    // Broadcaster mode: the newest round is filtered out of every read, stored and live alike.
    const hidden = [...rounds].sort((a, b) => b.start_time.localeCompare(a.start_time))[0].subsession_id;
    const keep = <T extends { subsession_id: number }>(rows: T[]) =>
      rows.filter((r) => r.subsession_id !== hidden);
    const hiddenStats = seasonRoundStatsFrom(season, keep(rounds), exhibitionIds, {
      driverRows: keep(stored.driverRows),
      teamRows: keep(stored.teamRows),
      penaltyRows: keep(stored.penaltyRows),
    });
    const context = buildSeasonOverallContext(
      exhibitionIds,
      inputs.drivers,
      keep(scores),
      keep(inputs.rawResults),
      keep(penalties),
      keep(inputs.seasonRounds),
      keep(inputs.lapStats),
    );
    for (const { name, classId } of views) {
      const ours = storedStandings(classId, hiddenStats);
      const live =
        classId === null
          ? buildOverallSeasonStandings({
              season,
              drivers: inputs.drivers,
              exhibitionIds,
              rulesets: inputs.rulesets,
              overallContext: context,
            })
          : buildSeasonStandings({
              season,
              classId,
              scoresRaw: keep(scores).filter((s) => s.class_id === classId),
              drivers: inputs.drivers,
              exhibitionIds,
              classes: inputs.classes,
              rulesets: inputs.rulesets,
              overallContext: context,
            });
      expect(rowsOf(ours), name).toEqual(rowsOf(live));
      for (const s of ours) expect(s.roundCells.has(hidden), name).toBe(false);
      expect(viewSubsessionIds(hiddenStats, classId ?? undefined).has(hidden)).toBe(false);
    }
  });

  it('falls back to the live path when a round is missing from the stored rows, and uses the stored rows otherwise', async () => {
    const missing = stats.driverRows[0].subsession_id;
    const pageRefs = {
      classes: inputs.classes,
      drivers: inputs.drivers,
      excludedIds: exhibitionIds,
      rulesets: inputs.rulesets,
      teams,
      carLogos: [],
      seasonLogoRows: [],
      circuits,
      layouts,
    };
    const env: SupabaseEnv = { url: 'https://example.invalid', anonKey: 'anon' };
    const golden = expected.views.overall.rows.map((r) => wanted('overall', r));
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      for (const complete of [false, true]) {
        const calls = stubDatabase(
          complete ? stored.driverRows : stored.driverRows.filter((r) => r.subsession_id !== missing),
        );
        const view = await loadDriverStandingsView(env, season, undefined, pageRefs);
        expect(view.source).toBe(complete ? 'stored' : 'live');
        expect(rowsOf(view.standings)).toEqual(golden);
        // Only the live path reads every score row; the stored path only counts them.
        expect(calls.some((c) => c.startsWith('GET race_score_results_public'))).toBe(!complete);
      }
    } finally {
      console.warn = warn;
    }
  });

  it("breaks a tie for a driver's primary team by team_id, whatever order the rounds come in", () => {
    const base = stats.driverRows[0];
    const row = (subsession_id: number, team_id: string): RoundDriverStatsRow => ({
      ...base,
      subsession_id,
      driver_id: 'tied',
      team_id,
      starts: 2,
      races_under_team: 2,
      races_scored_for_team: 1,
      cars: {},
    });
    for (const order of [
      [row(1, 'team-b'), row(2, 'team-a')],
      [row(1, 'team-a'), row(2, 'team-b')],
    ]) {
      const tied: SeasonRoundStats = { ...stats, driverRows: order, teamRows: [], penaltyRows: [] };
      const teamsOut = carTeamStatsFromRounds(tied, { teams: [], carLogos: [], seasonLogoRows: [] }).get(
        'tied',
      )!.teams;
      expect(teamsOut.map((t) => t.teamId)).toEqual(['team-a', 'team-b']);
    }
  });
});

/**
 * Answers the stored and live reads the standings view makes, from the ATC17 inputs; `driverRows` is what
 * round_driver_stats holds. Returns "METHOD table" for every request.
 */
function stubDatabase(driverRows: RoundDriverStatsRow[]): string[] {
  const calls: string[] = [];
  const capture = viewRows as { columns: string[]; rows: unknown[][] };
  const publicRows = capture.rows.map((values) => {
    const row: Record<string, unknown> = {
      season_id: season.id,
      raw_class_position: null,
      raw_overall_total: null,
      raw_class_total: null,
    };
    capture.columns.forEach((c, i) => (row[c] = values[i]));
    return row;
  });
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = decodeURIComponent(String(input));
    const path = url.split('/rest/v1/')[1];
    const table = path.split('?')[0];
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${table}`);
    if (method === 'HEAD') {
      return new Response(null, { headers: { 'Content-Range': `0-0/${publicRows.length}` } });
    }
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    // One page is enough for every read here (all under 1000 rows); later pages come back empty.
    const range = new Headers(init?.headers).get('Range');
    if (range && !range.startsWith('0-')) return json([]);
    switch (table) {
      case 'round_driver_stats':
        return json(driverRows);
      case 'round_team_stats':
        return json(stored.teamRows);
      case 'round_penalty_points':
        return json(stored.penaltyRows);
      case 'race_score_results_public':
        return json(publicRows);
      case 'penalties':
        return json(inputs.penalties);
      case 'curated_rounds':
        return json(path.includes('layout') ? rounds : inputs.seasonRounds);
      case 'curated_race_results':
        return json(path.includes('average_lap') ? inputs.lapStats : inputs.rawResults);
      default:
        throw new Error(`unexpected read: ${path}`);
    }
  }) as unknown as typeof fetch;
  return calls;
}
