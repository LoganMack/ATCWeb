import type { RestClient } from './client';
import type { Driver, DriverRecord } from './types';

/** Read shape — FK columns resolved to names via PostgREST resource embedding. */
const PUBLIC_SELECT =
  'id,car_number,name,is_rookie,car,appearances,starts,seasons_count,' +
  'penalty_points,penalty_points_max,' +
  'driver_statuses(name),driver_classes(name),teams(name,primary_color_hex,logo_url)';

/** Edit shape — raw FK columns, because that's what the admin form posts back. */
const ADMIN_SELECT =
  'id,car_number,name,status_id,class_id,team_id,is_rookie,car,appearances,starts,' +
  'seasons_count,penalty_points,penalty_points_max,photo_url,bio';

export function driversRepo(rest: RestClient) {
  return {
    /** All drivers, ordered by car number (unnumbered drivers last). */
    list() {
      return rest.get<Driver[]>(
        `drivers?select=${encodeURIComponent(PUBLIC_SELECT)}&order=car_number.asc.nullslast`
      );
    },

    async getById(id: string): Promise<DriverRecord | null> {
      const rows = await rest.get<DriverRecord[]>(
        `drivers?select=${ADMIN_SELECT}&id=eq.${encodeURIComponent(id)}`
      );
      return rows[0] ?? null;
    },

    create(data: Partial<DriverRecord>) {
      return rest.post<DriverRecord>('drivers', data);
    },

    update(id: string, data: Partial<DriverRecord>) {
      return rest.patch<DriverRecord>(`drivers?id=eq.${encodeURIComponent(id)}`, data);
    },

    remove(id: string) {
      return rest.remove(`drivers?id=eq.${encodeURIComponent(id)}`);
    },
  };
}
