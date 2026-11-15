/**
 * The fastest lap of each round within each class (round_best_laps_shown, 20261118120000_records_text_polls.sql),
 * the one input every computed track record is built from (functional spec W1; NFR1, NFR2). Exhibition and test
 * rounds are already left out, and hidden drivers are already masked by the view (BR1.1, BR1.9, NFR3).
 */
import { restGetAll, type SupabaseEnv } from './client';
import { memoized } from '../requestMemo';

export interface RoundBestLap {
  subsession_id: number;
  /** Null for a result with no scored class: it counts toward Overall only (BR1.9). */
  class_id: number | null;
  best_lap_ten_thousandths: number;
  race_number: number;
  finish_position: number;
  /** A negative stand-in for a hidden driver; never used to order (BR1.3). */
  cust_id: number;
  roster_driver_id: string | null;
  /** "Hidden Driver" for a hidden driver. */
  display_name: string;
  car_name: string | null;
  track_name: string;
  layout: string | null;
  start_time: string;
}

const ROUND_BEST_LAP_SELECT =
  'subsession_id,class_id,best_lap_ten_thousandths,race_number,finish_position,cust_id,roster_driver_id,' +
  'display_name,car_name,track_name,layout,start_time';

/**
 * Every row of the view, or only rounds that started at or before `maxStartTime` (the news recap's prior
 * record, BR1.8). One request per 1,000 rows, memoised per request. A failed read is logged and returns no
 * rows, so pages fall back to the typed records (functional spec section 8, "View request fails").
 */
export function getRoundBestLaps(
  env: SupabaseEnv,
  options: { maxStartTime?: string } = {},
): Promise<RoundBestLap[]> {
  const { maxStartTime } = options;
  return memoized(env, 'getRoundBestLaps', [maxStartTime ?? null], async () => {
    const filter = maxStartTime ? `&start_time=lte.${encodeURIComponent(maxStartTime)}` : '';
    try {
      return await restGetAll<RoundBestLap>(
        env,
        `round_best_laps_shown?select=${ROUND_BEST_LAP_SELECT}${filter}&order=subsession_id.asc,class_id.asc`,
      );
    } catch (err) {
      console.error('Failed to load round best laps; showing typed track records only:', err);
      return [];
    }
  });
}
