/**
 * Roles and the Broadcaster on the Worker side (broadcaster-staff-roles): panel access and full Admin
 * (BR2.2), the paths Staff can't open (BR2.7), the header's My Profile link (BR1.9) and who gets "View as
 * Broadcaster" (BR1.8). The database enforces the same rules; these decide what to render and where to send
 * a request.
 */
import { describe, expect, it } from 'vitest';
import {
  STAFF_RESTRICTED_PREFIXES,
  broadcasterModeFor,
  hasPanelAccess,
  isAdminView,
  isFullAdmin,
  isStaffRestrictedPath,
  myProfileLabel,
  myProfilePath,
} from '../../src/lib/auth';

type Locals = App.Locals;

function profile(
  overrides: Partial<{
    role: 'admin' | 'staff' | 'driver';
    driver_id: string | null;
    is_broadcaster: boolean;
  }>,
) {
  return {
    id: 'u-1',
    role: 'driver' as const,
    display_name: 'Someone',
    driver_id: null,
    iracing_cust_id: null,
    iracing_name: null,
    is_broadcaster: false,
    driver_name: null,
    ...overrides,
  };
}

function localsFor(p: ReturnType<typeof profile> | null, signedIn = true, viewAsVisitor = false): Locals {
  const session = signedIn
    ? { user: { id: 'u-1', email: 'x@example.test' }, profile: p, accessToken: 't' }
    : null;
  return { session, viewAsVisitor } as unknown as Locals;
}

describe('hasPanelAccess and isFullAdmin', () => {
  it.each([
    ['admin', true, true],
    ['staff', true, false],
    ['driver', false, false],
  ] as const)('%s: panel access %s, full Admin %s', (role, panel, full) => {
    expect(hasPanelAccess({ role })).toBe(panel);
    expect(isFullAdmin({ role })).toBe(full);
  });

  it('gives no access without a profile or with an unknown role', () => {
    expect(hasPanelAccess(null)).toBe(false);
    expect(hasPanelAccess(undefined)).toBe(false);
    expect(hasPanelAccess({ role: 'Admin' })).toBe(false);
    expect(isFullAdmin({ role: null })).toBe(false);
  });

  it('counts Staff in isAdminView, which View as Visitor still turns off', () => {
    expect(isAdminView(localsFor(profile({ role: 'staff' })))).toBe(true);
    expect(isAdminView(localsFor(profile({ role: 'staff' }), true, true))).toBe(false);
    expect(isAdminView(localsFor(profile({ role: 'driver' })))).toBe(false);
  });
});

describe('isStaffRestrictedPath', () => {
  it('restricts every listed area and everything under it, including the champions sub-pages', () => {
    for (const prefix of STAFF_RESTRICTED_PREFIXES) expect(isStaffRestrictedPath(prefix)).toBe(true);
    expect(isStaffRestrictedPath('/admin/champions/abc/1')).toBe(true);
    expect(isStaffRestrictedPath('/admin/champions/hall-of-fame/abc')).toBe(true);
    expect(isStaffRestrictedPath('/admin/circuits/abc/map/def')).toBe(true);
  });

  it('sees through case, encoding, doubled slashes, backslashes and a trailing slash', () => {
    expect(isStaffRestrictedPath('/Admin/Seasons')).toBe(true);
    expect(isStaffRestrictedPath('/admin/%73easons')).toBe(true);
    expect(isStaffRestrictedPath('/admin/%2573easons')).toBe(true);
    expect(isStaffRestrictedPath('//admin//rulesets/')).toBe(true);
    expect(isStaffRestrictedPath('/admin\\media')).toBe(true);
  });

  it('fails closed on a path that does not decode', () => {
    expect(isStaffRestrictedPath('/admin/%E0%A4%A')).toBe(true);
  });

  it('leaves the shared areas open, including look-alike names', () => {
    for (const path of [
      '/admin',
      '/admin/users',
      '/admin/drivers',
      '/admin/signups',
      '/admin/news/new',
      '/admin/import-tools',
      '/admin/seasons-archive',
      '/admin/mediakit',
    ]) {
      expect(isStaffRestrictedPath(path)).toBe(false);
    }
  });
});

describe('My Profile link', () => {
  it('goes to the linked driver as "My Profile"', () => {
    const locals = localsFor(profile({ driver_id: 'd-1' }));
    expect(myProfilePath(locals)).toBe('/drivers/d-1');
    expect(myProfileLabel(locals)).toBe('My Profile');
  });

  it('goes to /broadcaster as "Broadcaster" for the Broadcaster', () => {
    const locals = localsFor(profile({ is_broadcaster: true }));
    expect(myProfilePath(locals)).toBe('/broadcaster');
    expect(myProfileLabel(locals)).toBe('Broadcaster');
  });

  it('goes to /link-driver as "Link Driver" for an account with neither', () => {
    const locals = localsFor(profile({}));
    expect(myProfilePath(locals)).toBe('/link-driver');
    expect(myProfileLabel(locals)).toBe('Link Driver');
  });

  it('asks a signed-out visitor to sign in', () => {
    const locals = localsFor(null, false);
    expect(myProfilePath(locals)).toBe('/login?next=/my-profile');
    expect(myProfileLabel(locals)).toBe('My Profile');
  });
});

describe('broadcasterModeFor', () => {
  it('is on only for the Broadcaster with the cookie on', () => {
    expect(broadcasterModeFor({ is_broadcaster: true }, '1')).toBe(true);
    expect(broadcasterModeFor({ is_broadcaster: true }, undefined)).toBe(false);
    expect(broadcasterModeFor({ is_broadcaster: true }, '0')).toBe(false);
  });

  it('ignores the cookie for anyone else, an admin included', () => {
    expect(broadcasterModeFor({ is_broadcaster: false }, '1')).toBe(false);
    expect(broadcasterModeFor(profile({ role: 'admin' }), '1')).toBe(false);
    expect(broadcasterModeFor(null, '1')).toBe(false);
  });
});
