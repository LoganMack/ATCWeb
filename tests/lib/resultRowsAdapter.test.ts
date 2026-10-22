/**
 * The race_score_results_public adapter (src/lib/results/rows.ts): BR1.2, BR2.6, BR4.1. Rows are
 * plain objects shaped like the view; nothing here calls Supabase.
 */
import { describe, expect, it } from 'vitest';
import {
  rankedByClassTotal,
  seasonPointsOf,
  toScoreRow,
  type PublicScoreRow,
} from '../../src/lib/results/rows';
import { withHiddenRounds } from '../../src/lib/db/client';

function viewRow(over: Partial<PublicScoreRow> = {}): PublicScoreRow {
  return {
    subsession_id: 85326785,
    race_number: 1,
    driver_id: 'd1',
    season_id: 's17',
    class_id: 2,
    team_id: 't1',
    finish_position: 4,
    classified: true,
    dsq: false,
    raw_position: 4,
    shown_set: 'final',
    shown_position: 6,
    shown_class_position: 2,
    shown_laps_down: 0,
    shown_gap_ms: 7250,
    shown_race_time_ms: 2467512,
    shown_finish_points: 85,
    shown_class_points: 3,
    shown_finesse_bonus: 2,
    shown_pole_bonus: 0,
    shown_aggression_bonus: 2,
    shown_lap_led_bonus: 1,
    shown_fewest_incidents_bonus: 0,
    shown_fastest_lap_bonus: 0,
    shown_sprint_sweep_bonus: 0,
    shown_points_deduction: 10,
    shown_overall_total: 80,
    shown_class_total: 83,
    shown_penalised: true,
    raw_class_position: 1,
    raw_overall_total: 92,
    raw_class_total: 96,
    ...over,
  };
}

describe('toScoreRow', () => {
  it('maps every shown_ column of the view onto the row the readers use', () => {
    expect(toScoreRow(viewRow())).toEqual({
      subsession_id: 85326785,
      race_number: 1,
      driver_id: 'd1',
      season_id: 's17',
      class_id: 2,
      team_id: 't1',
      classified: true,
      dsq: false,
      finish_position: 4,
      raw_position: 4,
      set: 'final',
      position: 6,
      class_position: 2,
      laps_down: 0,
      gap_ms: 7250,
      race_time_ms: 2467512,
      finish_points: 85,
      class_points: 3,
      finesse_bonus: 2,
      pole_bonus: 0,
      aggression_bonus: 2,
      lap_led_bonus: 1,
      fewest_incidents_bonus: 0,
      fastest_lap_bonus: 0,
      sprint_sweep_bonus: 0,
      points_deduction: 10,
      overall_total: 80,
      class_total: 83,
      penalised: true,
      raw_class_position: 1,
      raw_overall_total: 92,
      raw_class_total: 96,
    });
  });

  it('counts the overall total for Alpha and the class total for Gamma and Delta', () => {
    const row = toScoreRow(viewRow());
    expect(
      ['Alpha', 'Gamma', 'Delta', undefined].map((c) => seasonPointsOf(row, rankedByClassTotal(c))),
    ).toEqual([80, 83, 83, 80]);
  });

  it('carries the raw set as shown: no deduction, not penalised, raw positions', () => {
    const row = toScoreRow(
      viewRow({
        shown_set: 'raw',
        shown_position: 4,
        shown_class_position: 1,
        shown_points_deduction: 0,
        shown_overall_total: 92,
        shown_class_total: 96,
        shown_penalised: false,
      }),
    );
    expect(row).toMatchObject({
      set: 'raw',
      position: 4,
      raw_position: 4,
      points_deduction: 0,
      penalised: false,
    });
    expect(seasonPointsOf(row, true)).toBe(96);
  });

  it('keeps a DSQ without a position but with its finishing slot and any flat penalty', () => {
    const row = toScoreRow(
      viewRow({
        dsq: true,
        raw_position: null,
        shown_position: null,
        shown_class_position: null,
        shown_finish_points: 0,
        shown_class_points: 0,
        shown_points_deduction: 25,
        shown_overall_total: -25,
        shown_class_total: -25,
      }),
    );
    expect(row).toMatchObject({ dsq: true, position: null, class_position: null, finish_position: 4 });
    expect(seasonPointsOf(row, false)).toBe(-25);
  });

  it('keeps a missing gap and race time as null', () => {
    const row = toScoreRow(viewRow({ shown_laps_down: 2, shown_gap_ms: null, shown_race_time_ms: null }));
    expect(row).toMatchObject({ laps_down: 2, gap_ms: null, race_time_ms: null });
  });
});

describe('View as Broadcaster', () => {
  it('hides the latest round from race_score_results_public as from every other round table', () => {
    const env = { url: 'https://x.supabase.co', anonKey: 'anon', hiddenSubsessionIds: [90000001] };
    expect(withHiddenRounds(env, 'race_score_results_public?select=driver_id&season_id=eq.s17')).toBe(
      'race_score_results_public?select=driver_id&season_id=eq.s17&subsession_id=not.in.(90000001)',
    );
    expect(withHiddenRounds(env, 'drivers?select=id')).toBe('drivers?select=id');
    expect(withHiddenRounds({ ...env, hiddenSubsessionIds: [] }, 'race_score_results_public')).toBe(
      'race_score_results_public',
    );
  });
});
