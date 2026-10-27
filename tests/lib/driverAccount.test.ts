/**
 * Driver account linking (U2 driver-linking, broadcaster-staff-roles): database error codes to typed codes
 * (NFR4.3), the unique-link clash on Admin > Users (NFR1.2), New Driver Sign-Up shaping before anything
 * reaches the database (BR5.1), the live number hint (BR5.2), the link state read model (C1), the page
 * loader's parallel reads (NFR3.2, NFR4.2), the Broadcaster claim (BR1.3) and code-only logs (NFR9.1).
 * PostgREST responses are stubbed through fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DRIVER_ACCOUNT_ERROR_CODES,
  DriverAccountError,
  adminLinkErrorMessage,
  carNumberStatus,
  claimBroadcaster,
  linkErrorMessage,
  linkMyDriver,
  loadLinkPage,
  mapDbError,
  parseDriverId,
  parseLinkState,
  requestErrorMessage,
  shapeRequestInput,
  submitDriverSignup,
} from '../../src/lib/driverAccount';
import { toSignupRequest, signupSourceLabel } from '../../src/lib/signups';

const env = { url: 'https://project.example.test', anonKey: 'anon-key' };
const DRIVER_ID = '11111111-2222-4333-8444-555555555555';

const respond = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

/** A PostgREST error body for a function that raised '<message>' with errcode P0001. */
const raised = (message: string) => respond({ code: 'P0001', message, details: null, hint: null }, 400);

/** A complete, valid New Driver Sign-Up form; each case overrides one field. */
const validForm = {
  name: 'Nico Newman',
  car_number: '55',
  irating: '2100',
  iracing_cust_id: '123456',
  nationality_1: 'us',
  nationality_2: 'ca',
};

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
    expect(mapDbError({ message: 'INVALID: irating: Enter your iRating (0 to 20000)' }).field).toBe(
      'irating',
    );
    expect(mapDbError({ message: 'INVALID: nationality_2: Pick Nationality 1 first' }).field).toBe(
      'nationality_2',
    );
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

  it('drops the code prefix from approval and Broadcaster errors for the admin', () => {
    expect(
      adminLinkErrorMessage(
        new Error('REQUESTER_ALREADY_LINKED: The requester is already linked to a driver'),
      ),
    ).toBe('The requester is already linked to a driver.');
    expect(adminLinkErrorMessage(new Error("ACCOUNT_LINKED: Remove this account's driver link first"))).toBe(
      "Remove this account's driver link first.",
    );
    expect(
      adminLinkErrorMessage(
        new Error(
          "REQUESTER_IS_BROADCASTER: This account is the Broadcaster, so it can't be linked to a driver. Reject the request instead",
        ),
      ),
    ).toBe("This account is the Broadcaster, so it can't be linked to a driver. Reject the request instead.");
    expect(adminLinkErrorMessage(new Error('Pick a class'))).toBeNull();
  });
});

describe('shapeRequestInput', () => {
  it('trims the name, strips control characters and converts the numbers and countries', () => {
    const shaped = shapeRequestInput({
      ...validForm,
      name: '  Nico\u0007 Newman\n ',
      car_number: ' 55 ',
      nationality_1: ' US ',
    });
    expect(shaped).toEqual({
      ok: true,
      input: {
        name: 'Nico Newman',
        carNumber: 55,
        irating: 2100,
        iracingCustId: 123456,
        nationality1: 'us',
        nationality2: 'ca',
      },
      values: {
        name: 'Nico Newman',
        car_number: '55',
        irating: '2100',
        iracing_cust_id: '123456',
        nationality_1: 'us',
        nationality_2: 'ca',
      },
    });
  });

  it('accepts the edges of each range and no nationality at all', () => {
    expect(shapeRequestInput({ ...validForm, name: 'x'.repeat(80), car_number: '0', irating: '0' }).ok).toBe(
      true,
    );
    expect(
      shapeRequestInput({
        ...validForm,
        car_number: '999',
        irating: '20000',
        iracing_cust_id: '9007199254740991',
      }).ok,
    ).toBe(true);
    const none = shapeRequestInput({ ...validForm, nationality_1: '', nationality_2: '' });
    expect(none.ok && none.input.nationality1).toBeNull();
    expect(none.ok && none.input.nationality2).toBeNull();
  });

  it.each([
    [{ name: '   ' }, 'name'],
    [{ name: 'x'.repeat(81) }, 'name'],
    [{ car_number: '1000' }, 'car_number'],
    [{ car_number: '-1' }, 'car_number'],
    [{ car_number: '5.5' }, 'car_number'],
    [{ car_number: '' }, 'car_number'],
    [{ irating: '' }, 'irating'],
    [{ irating: '20001' }, 'irating'],
    [{ irating: '-5' }, 'irating'],
    [{ iracing_cust_id: '0' }, 'iracing_cust_id'],
    [{ iracing_cust_id: '12e3' }, 'iracing_cust_id'],
    [{ iracing_cust_id: '12345678901234567' }, 'iracing_cust_id'],
    [{ iracing_cust_id: '9007199254740993' }, 'iracing_cust_id'],
    [{ nationality_1: 'xx' }, 'nationality_1'],
    [{ nationality_1: '', nationality_2: 'ca' }, 'nationality_2'],
    [{ nationality_1: 'us', nationality_2: 'US' }, 'nationality_2'],
    [{ name: null }, 'name'],
  ])('refuses %j at %s and keeps what was typed', (override, field) => {
    const shaped = shapeRequestInput({ ...validForm, ...override });
    expect(shaped.ok).toBe(false);
    if (shaped.ok) return;
    expect(shaped.field).toBe(field);
    expect(shaped.message.length).toBeGreaterThan(0);
    expect(shaped.values.iracing_cust_id).toBe(
      (override as { iracing_cust_id?: string }).iracing_cust_id ?? validForm.iracing_cust_id,
    );
  });

  it('refuses a missing iRating field altogether', () => {
    const shaped = shapeRequestInput({
      name: 'Nico',
      car_number: '5',
      irating: undefined,
      iracing_cust_id: '1',
    });
    expect(shaped.ok === false && shaped.field).toBe('irating');
  });
});

describe('carNumberStatus', () => {
  it('says available or taken for a whole number 0-999', () => {
    expect(carNumberStatus('55', [12, 7])).toEqual({ number: 55, taken: false, message: '#55 is available' });
    expect(carNumberStatus(' 7 ', [12, 7])).toEqual({ number: 7, taken: true, message: '#7 is taken' });
    expect(carNumberStatus('0', [])?.message).toBe('#0 is available');
  });

  it('gives nothing until the text is a valid number', () => {
    expect(carNumberStatus('', [7])).toBeNull();
    expect(carNumberStatus('1000', [7])).toBeNull();
    expect(carNumberStatus('7a', [7])).toBeNull();
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
        broadcaster: false,
        request: { status: 'pending', name: 'Nico Newman', car_number: 55, reason: null },
      }),
    ).toEqual({
      linked: false,
      driverId: null,
      broadcaster: false,
      broadcasterSlotTaken: false,
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
      broadcaster: false,
      broadcasterSlotTaken: false,
      request: null,
    });
  });

  it('reads the Broadcaster marker and slot, and treats anything but true as false', () => {
    const state = parseLinkState({
      linked: false,
      driver_id: null,
      broadcaster: true,
      broadcaster_slot_taken: true,
    });
    expect(state.broadcaster).toBe(true);
    expect(state.broadcasterSlotTaken).toBe(true);
    expect(parseLinkState({ broadcaster: 'true', broadcaster_slot_taken: 1 })).toMatchObject({
      broadcaster: false,
      broadcasterSlotTaken: false,
    });
  });

  it('treats unexpected shapes as unlinked with no request', () => {
    expect(parseLinkState(null)).toEqual({
      linked: false,
      driverId: null,
      broadcaster: false,
      broadcasterSlotTaken: false,
      request: null,
    });
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

  it('sends every sign-up field to submit_driver_signup', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond('"r-1"'));
    vi.stubGlobal('fetch', fetchMock);
    const shaped = shapeRequestInput(validForm);
    if (!shaped.ok) throw new Error('fixture form should shape');
    await expect(submitDriverSignup(env, 'user-token', shaped.input)).resolves.toBe('r-1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://project.example.test/rest/v1/rpc/submit_driver_signup');
    expect(JSON.parse(init.body)).toEqual({
      p_name: 'Nico Newman',
      p_car_number: 55,
      p_irating: 2100,
      p_iracing_cust_id: 123456,
      p_nationality_1: 'us',
      p_nationality_2: 'ca',
    });
  });

  it('never logs the request body or any email', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(raised('INVALID: name: Enter your full name (up to 80 characters)')),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await submitDriverSignup(env, 'user-token', {
      name: 'Nico Newman',
      carNumber: 55,
      irating: 2100,
      iracingCustId: 123456,
      nationality1: null,
      nationality2: null,
    }).catch((e: unknown) => e);
    expect((err as DriverAccountError).code).toBe('INVALID');
    expect((err as DriverAccountError).field).toBe('name');
    expect(error).toHaveBeenCalledWith('submit_driver_signup failed', 'INVALID');
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain('Nico');
    expect(logged).not.toContain('@');
  });

  it('claims the Broadcaster with the user token and no arguments', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond({ is_broadcaster: true }));
    vi.stubGlobal('fetch', fetchMock);
    await claimBroadcaster(env, 'user-token');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://project.example.test/rest/v1/rpc/claim_broadcaster');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer user-token');
    expect(JSON.parse(init.body)).toEqual({});
  });

  it('throws BROADCASTER_TAKEN when the slot went to someone else', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          raised('BROADCASTER_TAKEN: The Broadcaster slot was just taken by another account'),
        ),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await claimBroadcaster(env, 'user-token').catch((e: unknown) => e);
    expect((err as DriverAccountError).code).toBe('BROADCASTER_TAKEN');
  });

  it('maps a network failure to UNKNOWN', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await linkMyDriver(env, 'user-token', DRIVER_ID).catch((e: unknown) => e);
    expect((err as DriverAccountError).code).toBe('UNKNOWN');
  });
});

describe('loadLinkPage', () => {
  it('reads the state (with the slot), the list and the taken numbers in three parallel calls (NFR3)', async () => {
    const answers = new Map<string, (r: Response) => void>();
    const fetchMock = vi.fn(
      (url: string) => new Promise<Response>((resolve) => answers.set(url.split('/rpc/')[1], resolve)),
    );
    vi.stubGlobal('fetch', fetchMock);
    const page = loadLinkPage(env, 'user-token');
    // Every request is out before any answers.
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect([...answers.keys()].sort()).toEqual([
      'list_unlinked_drivers',
      'my_link_state',
      'taken_car_numbers',
    ]);
    answers.get('list_unlinked_drivers')!(respond([{ id: DRIVER_ID, name: 'Amy Brown', car_number: 12 }]));
    answers.get('my_link_state')!(
      respond({
        linked: false,
        driver_id: null,
        broadcaster: false,
        broadcaster_slot_taken: true,
        request: null,
      }),
    );
    answers.get('taken_car_numbers')!(respond([7, 12]));
    const data = await page;
    expect(data).toEqual({
      state: { linked: false, driverId: null, broadcaster: false, broadcasterSlotTaken: true, request: null },
      drivers: [{ id: DRIVER_ID, name: 'Amy Brown', car_number: 12 }],
      takenNumbers: [7, 12],
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

  it('falls back to no taken numbers when only that read fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('my_link_state')) return Promise.resolve(respond({ linked: false }));
        if (url.endsWith('list_unlinked_drivers')) return Promise.resolve(respond([]));
        return Promise.resolve(respond('boom', 500));
      }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const data = await loadLinkPage(env, 'user-token');
    expect(data).toMatchObject({ loadError: false, takenNumbers: [] });
    expect(data.state?.broadcasterSlotTaken).toBe(false);
  });
});

describe('messages', () => {
  it('names the driver when it was just taken, and says when the Broadcaster slot went', () => {
    expect(linkErrorMessage('DRIVER_TAKEN', 'Amy Brown')).toBe(
      'Amy Brown was just linked to another account. Pick your driver again.',
    );
    expect(linkErrorMessage('NOT_FOUND')).toBe("That driver can't be linked.");
    expect(linkErrorMessage('BROADCASTER_TAKEN')).toBe(
      'The Broadcaster slot was just taken by another account.',
    );
    expect(linkErrorMessage('UNKNOWN')).toBe('Something went wrong. Try again.');
  });

  it('puts request errors under the field they belong to', () => {
    expect(requestErrorMessage({ code: 'CAR_NUMBER_TAKEN', field: null }, 12)).toEqual({
      field: 'car_number',
      message: 'Car number 12 already belongs to a driver.',
    });
    expect(requestErrorMessage({ code: 'CAR_NUMBER_REQUESTED', field: null }, 56)).toEqual({
      field: 'car_number',
      message: 'Another driver has already asked for car number 56.',
    });
    expect(requestErrorMessage({ code: 'IRACING_ID_TAKEN', field: null }).field).toBe('iracing_cust_id');
    expect(requestErrorMessage({ code: 'REQUEST_PENDING', field: null }).field).toBeNull();
    expect(requestErrorMessage({ code: 'INVALID', field: 'irating' })).toEqual({
      field: 'irating',
      message: 'Enter your iRating (a whole number from 0 to 20000).',
    });
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
