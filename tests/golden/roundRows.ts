/**
 * Test-only reference: per-round stored rows derived from per-race inputs, mirroring U2's
 * private.build_round_stats (supabase/migrations/20261026120000_round_stats_expand.sql). The adapter
 * tests feed these rows to src/lib/results/roundStatsAdapter.ts and compare with today's per-race
 * builders, so the golden check is not circular: the rows come from the same inputs the live path reads,
 * through the SQL's per-row rules, never from the adapter.
 */
import type { CuratedRaceResultRow, DriverBasic, ScoreRow } from '../../src/lib/results/rows';
import type { Lookup } from '../../src/lib/db/lookups';
import type { Penalty } from '../../src/lib/db/penalties';
import type {
  RoundDriverStatsRow,
  RoundPenaltyPointsRow,
  RoundTeamStatsRow,
  StoredRoundStats,
} from '../../src/lib/db/roundStats';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The SQL's team top 2 of one race: points desc, then shown position (nulls last), then driver_id. */
function rankInTeam(rows: ScoreRow[], pointsOf: (r: ScoreRow) => number, byPosition: boolean): ScoreRow[] {
  return [...rows].sort(
    (a, b) =>
      pointsOf(b) - pointsOf(a) ||
      (byPosition ? (a.position ?? Infinity) - (b.position ?? Infinity) : 0) ||
      cmp(a.driver_id, b.driver_id),
  );
}

export function perRoundFromRaceRows({
  scores,
  rawResults,
  drivers,
  penalties,
  classes,
  postedIds,
}: {
  /** Every class's view rows for the season (the shown set). */
  scores: ScoreRow[];
  rawResults: CuratedRaceResultRow[];
  /** Non-AI drivers, as driversSelect returns them. */
  drivers: DriverBasic[];
  penalties: Penalty[];
  classes: Lookup[];
  /** Rounds whose incident report is posted: only they store penalty points. */
  postedIds: Set<number>;
}): StoredRoundStats {
  const custByDriver = new Map(
    drivers
      .filter((d) => !d.is_ai && d.iracing_cust_id != null)
      .map((d) => [d.id, d.iracing_cust_id as number]),
  );
  const driverByCust = new Map([...custByDriver].map(([d, c]) => [c, d]));
  const rawByKey = new Map(rawResults.map((r) => [`${r.subsession_id}:${r.race_number}:${r.cust_id}`, r]));
  const classNameById = new Map(classes.map((c) => [c.id, c.name]));

  const byRound = new Map<number, ScoreRow[]>();
  for (const s of scores) {
    if (!byRound.has(s.subsession_id)) byRound.set(s.subsession_id, []);
    byRound.get(s.subsession_id)!.push(s);
  }

  const driverRows: RoundDriverStatsRow[] = [];
  const teamRows: RoundTeamStatsRow[] = [];
  for (const [subsessionId, rows] of byRound) {
    // Race 1's grid position 1 among mapped non-AI drivers; the highest cust_id wins a tie.
    const poleCust = rawResults
      .filter(
        (r) =>
          r.subsession_id === subsessionId &&
          r.race_number === 1 &&
          r.starting_position === 1 &&
          driverByCust.has(r.cust_id),
      )
      .map((r) => r.cust_id)
      .sort((a, b) => b - a)[0];
    const poleDriver = poleCust !== undefined ? driverByCust.get(poleCust) : undefined;

    // races_scored_for_team: the team's top 2 of each race by overall_total.
    const scoredForTeam = new Set<ScoreRow>();
    const byRaceTeam = new Map<string, ScoreRow[]>();
    for (const s of rows) {
      if (!s.team_id) continue;
      const key = `${s.race_number}:${s.team_id}`;
      if (!byRaceTeam.has(key)) byRaceTeam.set(key, []);
      byRaceTeam.get(key)!.push(s);
    }
    for (const group of byRaceTeam.values()) {
      for (const s of rankInTeam(group, (r) => r.overall_total, true).slice(0, 2)) scoredForTeam.add(s);
    }

    const byDriver = new Map<string, ScoreRow[]>();
    for (const s of rows) {
      if (!byDriver.has(s.driver_id)) byDriver.set(s.driver_id, []);
      byDriver.get(s.driver_id)!.push(s);
    }
    for (const [driverId, ds] of byDriver) {
      const first = ds[0];
      const cust = custByDriver.get(driverId);
      const raws = ds.map((s) =>
        cust !== undefined ? rawByKey.get(`${s.subsession_id}:${s.race_number}:${cust}`) : undefined,
      );
      const ok = (s: ScoreRow) => !s.dsq;
      const cars: Record<string, number> = {};
      for (const r of raws) if (r?.car_name) cars[r.car_name] = (cars[r.car_name] ?? 0) + 1;
      driverRows.push({
        subsession_id: subsessionId,
        driver_id: driverId,
        season_id: first.season_id,
        class_id: first.class_id,
        team_id: first.team_id,
        final_visible: postedIds.has(subsessionId),
        overall_points: ds.reduce((sum, s) => sum + s.overall_total, 0),
        class_points: ds.reduce((sum, s) => sum + s.class_total, 0),
        starts: ds.length,
        class_wins: ds.filter((s) => ok(s) && s.class_position === 1).length,
        class_podiums: ds.filter((s) => ok(s) && s.class_position !== null && s.class_position <= 3).length,
        class_top5s: ds.filter((s) => ok(s) && s.class_position !== null && s.class_position <= 5).length,
        class_top10s: ds.filter((s) => ok(s) && s.class_position !== null && s.class_position <= 10).length,
        overall_wins: ds.filter((s) => ok(s) && s.position === 1).length,
        overall_podiums: ds.filter((s) => ok(s) && s.position !== null && s.position <= 3).length,
        overall_top5s: ds.filter((s) => ok(s) && s.position !== null && s.position <= 5).length,
        overall_top10s: ds.filter((s) => ok(s) && s.position !== null && s.position <= 10).length,
        overall_pole: poleDriver === driverId,
        class_pole: ds.some((s) => s.pole_bonus > 0),
        laps: raws.reduce((sum, r) => sum + (r?.laps_complete ?? 0), 0),
        laps_led: raws.reduce((sum, r) => sum + (r?.laps_led ?? 0), 0),
        net_positions: raws.reduce(
          (sum, r) =>
            sum +
            (r && r.starting_position !== null
              ? r.starting_position - (r.adjusted_position ?? r.finish_position)
              : 0),
          0,
        ),
        incidents: raws.reduce((sum, r) => sum + (r?.incidents ?? 0), 0),
        bonus_points: ds.reduce((sum, s) => sum + s.finesse_bonus + s.pole_bonus, 0),
        cars,
        races_under_team: ds.filter((s) => s.team_id !== null).length,
        races_scored_for_team: ds.filter((s) => scoredForTeam.has(s)).length,
      });
    }

    // round_team_stats: 'overall' by overall_total, and the Alpha and Delta class competitions.
    const competitions: { key: string; rows: ScoreRow[]; pointsOf: (r: ScoreRow) => number }[] = [
      { key: 'overall', rows: rows.filter((s) => s.team_id), pointsOf: (r) => r.overall_total },
    ];
    for (const c of classes) {
      if (c.name !== 'Alpha' && c.name !== 'Delta') continue;
      const classTotal = classNameById.get(c.id) === 'Delta' || classNameById.get(c.id) === 'Gamma';
      competitions.push({
        key: String(c.id),
        rows: rows.filter((s) => s.team_id && s.class_id === c.id),
        pointsOf: (r) => (classTotal ? r.class_total : r.overall_total),
      });
    }
    for (const comp of competitions) {
      const byTeam = new Map<string, ScoreRow[]>();
      for (const s of comp.rows) {
        if (!byTeam.has(s.team_id!)) byTeam.set(s.team_id!, []);
        byTeam.get(s.team_id!)!.push(s);
      }
      for (const [teamId, ts] of byTeam) {
        const races = new Map<number, ScoreRow[]>();
        for (const s of ts) {
          if (!races.has(s.race_number)) races.set(s.race_number, []);
          races.get(s.race_number)!.push(s);
        }
        let points = 0;
        for (const raceRows of races.values()) {
          for (const s of rankInTeam(raceRows, comp.pointsOf, false).slice(0, 2)) points += comp.pointsOf(s);
        }
        teamRows.push({
          subsession_id: subsessionId,
          team_id: teamId,
          competition: comp.key,
          season_id: ts[0].season_id,
          points,
          starts: ts.length,
        });
      }
    }
  }

  // round_penalty_points: posted rounds that have score rows, every penalised driver, appeal-aware.
  const seasonByRound = new Map(scores.map((s) => [s.subsession_id, s.season_id]));
  const pp = new Map<string, RoundPenaltyPointsRow>();
  for (const p of penalties) {
    if (!p.driver_id || !postedIds.has(p.subsession_id) || !seasonByRound.has(p.subsession_id)) continue;
    const key = `${p.subsession_id}:${p.driver_id}`;
    const row = pp.get(key) ?? {
      subsession_id: p.subsession_id,
      driver_id: p.driver_id,
      season_id: seasonByRound.get(p.subsession_id)!,
      penalty_points: 0,
    };
    row.penalty_points += p.is_appealed ? p.appeal_penalty_points : p.penalty_points;
    pp.set(key, row);
  }

  return { driverRows, teamRows, penaltyRows: [...pp.values()] };
}
