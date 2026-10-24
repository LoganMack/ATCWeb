/**
 * Rendering decisions for "Hidden Driver" and private profiles (U4 driver-privacy, BR9.11, BR9.14).
 *
 * The database already masks a hidden driver's name, photo, bio and customer id in the *_shown views and
 * says so with is_hidden and profile_private; these helpers only turn those flags into links and badges,
 * so no page decides from the name itself.
 */

/** The name the masked views return for a driver hidden from this caller. */
export const HIDDEN_DRIVER_NAME = 'Hidden Driver';

/** The two flags drivers_shown adds; older reads that do not select them count as visible. */
export interface DriverPrivacyFlags {
  is_hidden?: boolean | null;
  profile_private?: boolean | null;
}

export function isDriverHidden(row: DriverPrivacyFlags | null | undefined): boolean {
  return row?.is_hidden === true;
}

export function isProfilePrivate(row: DriverPrivacyFlags | null | undefined): boolean {
  return row?.profile_private === true;
}

/** The profile link for a driver, or null when there is no id or the driver is hidden (no profile link). */
export function driverHref(row: ({ id?: string | null } & DriverPrivacyFlags) | null | undefined): string | null {
  if (!row?.id || isDriverHidden(row)) return null;
  return `/drivers/${row.id}`;
}

/** The driver's photo URL, or null when there is none or the driver is hidden. */
export function driverPhoto(row: ({ photo_url?: string | null } & DriverPrivacyFlags) | null | undefined): string | null {
  if (!row || isDriverHidden(row)) return null;
  return row.photo_url ?? null;
}

/**
 * The text of the badge shown instead of a photo: the car number, else the name's first letter, but never
 * a letter for a hidden driver (Q7 A); a hidden driver with no number gets an empty badge.
 */
export function driverInitialBadge(
  row: ({ car_number?: number | null; name?: string | null } & DriverPrivacyFlags) | null | undefined,
): string {
  if (!row) return '';
  if (row.car_number !== null && row.car_number !== undefined) return `#${row.car_number}`;
  if (isDriverHidden(row)) return '';
  return (row.name ?? '').trim().charAt(0);
}

/** Where the private profile notice sends a visitor: log in when signed out, else link a driver (BR9.11). */
export function privateProfileAction(
  driverId: string,
  signedIn: boolean,
): { label: string; href: string } {
  return signedIn
    ? { label: 'Link your driver', href: '/link-driver' }
    : { label: 'Log in', href: `/login?next=${encodeURIComponent(`/drivers/${driverId}`)}` };
}
