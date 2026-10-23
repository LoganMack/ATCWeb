/**
 * Driver account linking (U2 driver-linking): database error codes to typed codes (NFR4.3), the unique-link
 * clash on Admin > Users (NFR1.2), input shaping before anything reaches the database (NFR1.9), the link state
 * read model (C1), the page loader's two parallel reads (NFR3.2, NFR4.2), and code-only logs (NFR9.1).
 * PostgREST responses are stubbed through fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DRIVER_ACCOUNT_ERROR_CODES,
  DriverAccountError,
  adminLinkErrorMessage,
  linkErrorMessage,
  linkMyDriver,
  loadLinkPage,
  mapDbError,
  parseDriverId,
  parseLinkState,
  requestErrorMessage,
  shapeRequestInput,
  submitDriverRequest,
} from '../../src/lib/driverAccount';
import { toSignupRequest, signupSourceLabel } from '../../src/lib/signups';

const env = { url: 'https://project.example.test', anonKey: 'anon-key' };
const DRIVER_ID = '11111111-2222-4333-8444-555555555555';

const respond = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

/** A PostgREST error body for a function that raised '<message>' with errcode P0001. */
const raised = (message: string) => respond({ code: 'P0001', message, details: null, hint: null }, 400);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('mapDbError', () => {
  it.each(DRIVER_ACCOUNT_ERROR_CODES)('maps a %s raise to its code', (code) => {
    expect(mapDbError({ code: 'P0001', message: `${code}: something happened` }).code).toBe(code);
  });

  it('names the field of an INVALID error and keeps the readable detail', () => {
    expect(mapDbError({ message: 'INVALID: car_number: Enter a car number from 0 to 999' })).toEqual({
      code: 'INVALID',
      field: 'car_number',
      detail: 'Enter a car number from 0 to 999',
    });
  });

  it('treats unknown prefixes, plain messages and empty input as UNKNOWN', () => {
    expect(mapDbError({ message: 'SOMETHING_ELSE: nope' }).code).toBe('UNKNOWN');
    expect(mapDbError(new Error('Supabase rpc error 500')).code).toBe('UNKNOWN');
    expect(mapDbError(null).code).toBe('UNKNOWN');
    expect(mapDbError({ message: 'INVALID: colour: bad' }).field).toBeNull();
  });

  it('maps a unique violation on the one-account-per-driver index to DRIVER_ALREADY_LINKED', () => {
    // What setProfileDriver throws on Admin > Users: the status plus the PostgREST body.
    const err = new Error(
      'Failed to link driver (409): {"code":"23505","details":"Key (driver_id)=(x) already exists.","message":"duplicate key value violates unique constraint \\"profiles_driver_id_unique\\""}',
    );
    expect(mapDbError(err).code).toBe('DRIVER_ALREADY_LINKED');
    expect(adminLinkErrorMessage(err)).toBe('That driver is already linked to another account.');
    // Another table's unique violation is not a link clash.
    expect(
      mapDbError({
        code: '23505',
        message: 'duplicate key value violates unique constraint "drivers_name_key"',
      }).code,
    ).toBe('UNKNOWN');
  });

  it('drops the code prefix from approval errors for the admin', () => {
    expect(
      adminLinkErrorMessage(
        new Error('REQUESTER_ALREADY_LINKED: The requester is already linked to a driver'),
      ),
    ).toBe('The requester is already linked to a driver.');
    expect(adminLinkErrorMessage(new Error('Pick a class'))).toBeNull();
  });
});

describe('shapeRequestInput', () => {
  it('trims the name, strips control characters and converts the numbers', () => {
    const shaped = shapeRequestInput({
      name: '  Nico\u0007 Newman\n ',
      car_number: ' 55 ',
      iracing_cust_id: '123456',
    });
    expect(shaped).toEqual({
      ok: true,
      input: { name: 'Nico Newman', carNumber: 55, iracingCustId: 123456 },
      values: { name: 'Nico Newman', car_number: '55', iracing_cust_id: '123456' },
    });
  });

  it('accepts the edges of each range', () => {
    expect(shapeRequestInput({ name: 'x'.repeat(80), car_number: '0', iracing_cust_id: '1' }).ok).toBe(true);
    expect(shapeRequestInput({ name: 'A', car_number: '999', iracing_cust_id: '9007199254740991' }).ok).toBe(
      true,
    );
  });

  it.each([
    [{ name: '   ', car_number: '5', iracing_cust_id: '1' }, 'name'],
    [{ name: 'x'.repeat(81), car_number: '5', iracing_cust_id: '1' }, 'name'],
    [{ name: 'Nico', car_number: '1000', iracing_cust_id: '1' }, 'car_number'],
    [{ name: 'Nico', car_number: '-1', iracing_cust_id: '1' }, 'car_number'],
    [{ name: 'Nico', car_number: '5.5', iracing_cust_id: '1' }, 'car_number'],
    [{ name: 'Nico', car_number: '', iracing_cust_id: '1' }, 'car_number'],
    [{ name: 'Nico', car_number: '5', iracing_cust_id: '0' }, 'iracing_cust_id'],
    [{ name: 'Nico', car_number: '5', iracing_cust_id: '12e3' }, 'iracing_cust_id'],
    [{ name: 'Nico', car_number: '5', iracing_cust_id: '9007199254740993' }, 'iracing_cust_id'],
    [{ name: null, car_number: undefined, iracing_cust_id: 5 }, 'name'],
  ])('refuses %j at %s and keeps what was typed', (form, field) => {
    const shaped = shapeRequestInput(form);
    expect(shaped.ok).toBe(false);
    if (shaped.ok) return;
    expect(shaped.field).toBe(field);
    expect(shaped.message.length).toBeGreaterThan(0);
  });
});

describe('parseDriverId', () => {
  it('accepts only a UUID', () => {
    expect(parseDriverId(` ${DRIVER_ID.toUpperCase()} `)).toBe(DRIVER_ID);
    expect(parseDriverId('not-a-uuid')).toBeNull();
    expect(parseDriverId("1' or '1'='1")).toBeNull();
    expect(parseDriverId(null)).toBeNull();
  });
});

describe('parseLinkState', () => {
  it('reads a pending request', () => {
    expect(
      parseLinkState({
        linked: false,
        driver_id: null,
        request: { status: 'pending', name: 'Nico Newman', car_number: 55, reason: null },
      }),
    ).toEqual({
      linked: false,
      driverId: null,
      request: { status: 'pending', name: 'Nico Newman', carNumber: 55, reason: null },
    });
  });

  it('reads a rejected request with its reason, and a linked account', () => {
    const rejected = parseLinkState({
      linked: false,
      driver_id: null,
      request: { status: 'rejected', name: 'Nico', car_number: 5, reason: 'Use your full name' },
    });
    expect(rejected.request?.reason).toBe('Use your full name');
    expect(parseLinkState({ linked: true, driver_id: DRIVER_ID, request: null })).toEqual({
      linked: true,
      driverId: DRIVER_ID,
      request: null,
    });
  });

  it('treats unexpected shapes as unlinked with no request', () => {
    expect(parseLinkState(null)).toEqual({ linked: false, driverId: null, request: null });
    expect(parseLinkState({ request: { status: 'cancelled', name: 'x' } }).request).toBeNull();
  });
});

describe('linking calls', () => {
  it('links with the user token and resolves to the driver id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond({ driver_id: DRIVER_ID }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(linkMyDriver(env, 'user-token', DRIVER_ID)).resolves.toBe(DRIVER_ID);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://project.example.test/rest/v1/rpc/link_my_driver');
    expect(init.headers.Authorization).toBe('Bearer user-token');
    expect(JSON.parse(init.body)).toEqual({ p_driver_id: DRIVER_ID });
  });

  it('throws DRIVER_TAKEN and logs it at warn with the code only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(raised('DRIVER_TAKEN: Amy Brown was just linked to another account')),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await linkMyDriver(env, 'user-token', DRIVER_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverAccountError);
    expect((err as DriverAccountError).code).toBe('DRIVER_TAKEN');
    expect(warn).toHaveBeenCalledWith('link_my_driver failed', 'DRIVER_TAKEN');
    expect(error).not.toHaveBeenCalled();
  });

  it('never logs the request body or any email', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(raised('INVALID: name: Enter your full name (up to 80 characters)')),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await submitDriverRequest(env, 'user-token', {
      name: 'Nico Newman',
      carNumber: 55,
      iracingCustId: 123456,
    }).catch((e: unknown) => e);
    expect((err as DriverAccountError).code).toBe('INVALID');
    expect((err as DriverAccountError).field).toBe('name');
    expect(error).toHaveBeenCalledWith('submit_driver_request failed', 'INVALID');
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain('Nico');
    expect(logged).not.toContain('@');
  });

  it('maps a network failure to UNKNOWN', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await linkMyDriver(env, 'user-token', DRIVER_ID).catch((e: unknown) => e);
    expect((err as DriverAccountError).code).toBe('UNKNOWN');
  });
});

describe('loadLinkPage', () => {
  it('reads the state and the list in two parallel calls', async () => {
    const answers = new Map<string, (r: Response) => void>();
    const fetchMock = vi.fn(
      (url: string) => new Promise<Response>((resolve) => answers.set(url.split('/rpc/')[1], resolve)),
    );
    vi.stubGlobal('fetch', fetchMock);
    const page = loadLinkPage(env, 'user-token');
    // Both requests are out before either answers.
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([...answers.keys()].sort()).toEqual(['list_unlinked_drivers', 'my_link_state']);
    answers.get('list_unlinked_drivers')!(respond([{ id: DRIVER_ID, name: 'Amy Brown', car_number: 12 }]));
    answers.get('my_link_state')!(respond({ linked: false, driver_id: null, request: null }));
    const data = await page;
    expect(data).toEqual({
      state: { linked: false, driverId: null, request: null },
      drivers: [{ id: DRIVER_ID, name: 'Amy Brown', car_number: 12 }],
      loadError: false,
    });
  });

  it('reports a load error instead of throwing when a read fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(url.endsWith('my_link_state') ? respond({ linked: false }) : respond('boom', 500)),
      ),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const data = await loadLinkPage(env, 'user-token');
    expect(data.loadError).toBe(true);
    expect(data.drivers).toEqual([]);
    expect(data.state?.linked).toBe(false);
  });
});

describe('messages', () => {
  it('names the driver when it was just taken', () => {
    expect(linkErrorMessage('DRIVER_TAKEN', 'Amy Brown')).toBe(
      'Amy Brown was just linked to another account. Pick your driver again.',
    );
    expect(linkErrorMessage('NOT_FOUND')).toBe("That driver can't be linked.");
    expect(linkErrorMessage('UNKNOWN')).toBe('Something went wrong. Try again.');
  });

  it('puts request errors under the field they belong to', () => {
    expect(requestErrorMessage({ code: 'CAR_NUMBER_TAKEN', field: null }, 12)).toEqual({
      field: 'car_number',
      message: 'Car number 12 already belongs to a driver.',
    });
    expect(requestErrorMessage({ code: 'IRACING_ID_TAKEN', field: null }).field).toBe('iracing_cust_id');
    expect(requestErrorMessage({ code: 'REQUEST_PENDING', field: null }).field).toBeNull();
    expect(requestErrorMessage({ code: 'INVALID', field: 'name' }).field).toBe('name');
  });
});

describe('sign-up rows on Admin > Sign-ups', () => {
  it('flattens the requester and labels the source', () => {
    const row = toSignupRequest({
      id: 'r-1',
      source: 'website',
      discord_user_id: null,
      discord_username: null,
      requester_profile_id: 'u-1',
      requester: { display_name: 'Driver B' },
      name: 'Nico Newman',
      iracing_cust_id: 123456,
      requested_numbers: [55],
      status: 'pending',
      reason: null,
      driver_id: null,
      decided_by: null,
      decided_at: null,
      notified_at: null,
      created_at: '2026-10-21T00:00:00Z',
    });
    expect(row.requester_display_name).toBe('Driver B');
    expect('requester' in row).toBe(false);
    expect(signupSourceLabel(row)).toBe('Website');
    expect(signupSourceLabel({ source: 'discord', discord_username: null, discord_user_id: '123' })).toBe(
      '123',
    );
  });
});
