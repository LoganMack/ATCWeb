import type { RestClient } from './client';
import type { Lookup } from './types';

/**
 * The small reference tables that back the admin form <select> dropdowns.
 * Both are public-readable (`0001_init.sql`), so no token needed.
 */
export function lookupsRepo(rest: RestClient) {
  return {
    driverStatuses() {
      return rest.get<Lookup[]>('driver_statuses?select=id,name,sort_order&order=sort_order.asc');
    },

    driverClasses() {
      return rest.get<Lookup[]>('driver_classes?select=id,name,sort_order&order=sort_order.asc');
    },
  };
}
