/**
 * The rendering helpers for "Hidden Driver" and private profiles (U4, src/lib/privacy.ts): links, photos and
 * badges follow the view's is_hidden / profile_private flags, never the name.
 */
import { describe, expect, it } from 'vitest';
import {
  HIDDEN_DRIVER_NAME,
  driverHref,
  driverInitialBadge,
  driverPhoto,
  isDriverHidden,
  isProfilePrivate,
  privateProfileAction,
} from '../../src/lib/privacy';
import { displayDriverName, shortDriverName } from '../../src/lib/db/circuits';

const ID = '99999999-0000-0000-0000-000000000601';

describe('privacy helpers (U4)', () => {
  it('links a visible driver to the profile and a hidden one nowhere (BR9.14)', () => {
    expect(driverHref({ id: ID })).toBe(`/drivers/${ID}`);
    expect(driverHref({ id: ID, is_hidden: false })).toBe(`/drivers/${ID}`);
    expect(driverHref({ id: ID, is_hidden: true })).toBeNull();
    expect(driverHref({ id: null })).toBeNull();
    expect(driverHref(undefined)).toBeNull();
  });

  it('drops the photo of a hidden driver, even if one were sent', () => {
    expect(driverPhoto({ photo_url: 'https://x/p.png' })).toBe('https://x/p.png');
    expect(driverPhoto({ photo_url: 'https://x/p.png', is_hidden: true })).toBeNull();
    expect(driverPhoto({ photo_url: null })).toBeNull();
    expect(driverPhoto(null)).toBeNull();
  });

  it('badges with the car number, and never a letter of a hidden driver (Q7 A)', () => {
    expect(driverInitialBadge({ car_number: 12, name: 'Amy Brown' })).toBe('#12');
    expect(driverInitialBadge({ car_number: 12, name: HIDDEN_DRIVER_NAME, is_hidden: true })).toBe('#12');
    expect(driverInitialBadge({ car_number: null, name: 'Amy Brown' })).toBe('A');
    expect(driverInitialBadge({ car_number: null, name: HIDDEN_DRIVER_NAME, is_hidden: true })).toBe('');
    expect(driverInitialBadge({ car_number: 0, name: 'Zero' })).toBe('#0');
    expect(driverInitialBadge(null)).toBe('');
  });

  it('reads the flags strictly, so a row without them counts as visible', () => {
    expect(isDriverHidden({})).toBe(false);
    expect(isDriverHidden({ is_hidden: null })).toBe(false);
    expect(isDriverHidden({ is_hidden: true })).toBe(true);
    expect(isProfilePrivate({})).toBe(false);
    expect(isProfilePrivate({ profile_private: true })).toBe(true);
    expect(isProfilePrivate(undefined)).toBe(false);
  });

  it('sends a signed-out visitor to log in and back, and a signed-in one to link a driver (BR9.11)', () => {
    expect(privateProfileAction(ID, false)).toEqual({
      label: 'Log in',
      href: `/login?next=${encodeURIComponent(`/drivers/${ID}`)}`,
    });
    expect(privateProfileAction(ID, true)).toEqual({ label: 'Link your driver', href: '/link-driver' });
  });

  it('keeps "Hidden Driver" whole in the short and display name forms', () => {
    expect(shortDriverName(HIDDEN_DRIVER_NAME)).toBe(HIDDEN_DRIVER_NAME);
    expect(displayDriverName(HIDDEN_DRIVER_NAME)).toBe(HIDDEN_DRIVER_NAME);
    expect(shortDriverName('John Michael Smith')).toBe('J. Smith');
  });
});
