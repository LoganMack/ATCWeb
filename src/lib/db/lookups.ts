import { restGet, type SupabaseEnv } from './client';
import { memoized } from '../requestMemo';

// --- Lookups (for building <select> dropdowns in admin forms) --------------

export interface Lookup {
  id: number;
  name: string;
  sort_order: number;
}

export function getDriverStatuses(env: SupabaseEnv) {
  return restGet<Lookup[]>(env, 'driver_statuses?select=id,name,sort_order&order=sort_order.asc');
}

export function getDriverClasses(env: SupabaseEnv) {
  return memoized(env, 'getDriverClasses', [], () =>
    restGet<Lookup[]>(env, 'driver_classes?select=id,name,sort_order&order=sort_order.asc'),
  );
}
