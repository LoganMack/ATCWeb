import { describe, expect, it } from 'vitest';
import { withHiddenRounds, type SupabaseEnv } from '../../src/lib/db/client';

// Broadcaster mode hides the latest round from every subsession-keyed table (BR3.3). The round stats
// tables hold a round's own numbers, so they must be filtered too, or the hidden round would show.
const ROUND_STATS_TABLES = ['round_driver_stats', 'round_team_stats', 'round_penalty_points'];

const env = (hiddenSubsessionIds?: number[]): SupabaseEnv => ({
  url: 'https://example.invalid',
  anonKey: 'anon',
  hiddenSubsessionIds,
});

describe('withHiddenRounds on the round stats tables', () => {
  it('filters a hidden round out of each round stats table', () => {
    for (const table of ROUND_STATS_TABLES) {
      expect(withHiddenRounds(env([71031341, 71031342]), table)).toBe(
        `${table}?subsession_id=not.in.(71031341,71031342)`,
      );
    }
  });

  it('adds no filter when nothing is hidden', () => {
    for (const table of ROUND_STATS_TABLES) {
      const path = `${table}?select=*&season_id=eq.abc`;
      expect(withHiddenRounds(env(), path)).toBe(path);
      expect(withHiddenRounds(env([]), path)).toBe(path);
    }
  });

  it('keeps an existing query string and its parameters', () => {
    const path =
      'round_driver_stats?select=driver_id,overall_points&season_id=eq.abc&order=subsession_id.asc';
    expect(withHiddenRounds(env([42]), path)).toBe(`${path}&subsession_id=not.in.(42)`);
    // A table that is not subsession-keyed stays untouched.
    expect(withHiddenRounds(env([42]), 'drivers?select=id')).toBe('drivers?select=id');
  });
});
