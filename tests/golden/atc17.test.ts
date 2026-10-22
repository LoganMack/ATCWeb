/**
 * Golden test (BR2.3): the pure standings path reproduces ATC17 exactly as the live site showed it
 * before the standings code was extracted. expected.json is the oracle and is never edited to make
 * this pass; a difference is a finding (see tests/fixtures/golden/atc17/README.md).
 *
 * Since the switch the standings read race_score_results_public. The only totals that changed are
 * listed in DECIDED (./atc17.ts), each with the comparison cause the owner accepted.
 */
import { describe, expect, it } from 'vitest';
import { DECIDED, buildContext, expected, standingsFor, wanted, type GoldenRow } from './atc17';

const context = buildContext();

describe('ATC17 golden standings', () => {
  it('has the overall view and every class view', () => {
    expect(Object.keys(expected.views).sort()).toEqual(['Alpha', 'Delta', 'Gamma', 'overall']);
  });

  it.each(Object.entries(expected.views))('%s matches the live page', (name, view) => {
    const actual: GoldenRow[] = standingsFor(view.classId, context).map((s) => ({
      position: s.position,
      driverId: s.driver.id,
      total: s.totalPoints,
    }));

    const differences: string[] = [];
    const rows = Math.max(actual.length, view.rows.length);
    for (let i = 0; i < rows; i++) {
      const want = view.rows[i] && wanted(name, view.rows[i]);
      const got = actual[i];
      if (!want || !got) {
        const who = (want ?? got).driverId;
        differences.push(
          `${name}, row ${i + 1}, driver ${who}: ${want ? 'missing from the result' : 'not on the live page'}`,
        );
        continue;
      }
      for (const field of ['position', 'driverId', 'total'] as const) {
        if (want[field] !== got[field]) {
          differences.push(
            `${name}, row ${i + 1}, driver ${want.driverId}: ${field} expected ${want[field]}, got ${got[field]}`,
          );
        }
      }
    }
    expect(differences).toEqual([]);
  });

  it('lists only drivers whose live-page total differs', () => {
    for (const [name, totals] of Object.entries(DECIDED)) {
      const live = new Map(expected.views[name].rows.map((r) => [r.driverId, r.total]));
      for (const [driverId, total] of Object.entries(totals)) {
        expect(live.get(driverId), `${name} ${driverId}`).not.toBe(total);
        expect(live.has(driverId), `${name} ${driverId}`).toBe(true);
      }
    }
  });
});
