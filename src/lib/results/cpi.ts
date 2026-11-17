/**
 * Corners per Incident as shown on the standings and the race header (contract C4). Same rule as the
 * existing per-driver CPI cells: unknown corners or no incidents show a dash, otherwise one decimal.
 * No server-only imports, so client scripts (the standings slider) can use it too.
 */
export const CPI_DASH = '—';

export function formatCpi(corners: number | null | undefined, incidents: number): string {
  if (corners === null || corners === undefined || !Number.isFinite(corners)) return CPI_DASH;
  if (!incidents) return CPI_DASH;
  return (corners / incidents).toFixed(1);
}
