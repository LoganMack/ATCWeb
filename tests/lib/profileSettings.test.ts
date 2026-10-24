/**
 * Account settings and the own-profile controller (U3 profile-settings): the settings read and upsert (C3,
 * NFR1.2), the retry-safe save order and its messages (NFR4.1-NFR4.3), email change and password reset
 * mapping (NFR1.4-NFR1.6), the per-account email limit (claim_email_action), owner-only intents with JSON
 * or redirect answers (NFR1.3, C4), the owner render's call count (NFR3.1) and address-free logs (NFR9.1).
 * PostgREST, Storage and GoTrue are stubbed through fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ACCOUNT_SETTINGS,
  DriverAccountError,
  claimEmailAction,
  getMySettings,
  handleProfilePost,
  inPlaceStatusMessage,
  loadOwnerProfile,
  parseAccountSettings,
  requestEmailChange,
  requestOwnPasswordReset,
  resolveProfileIntent,
  saveFailureMessage,
  saveMySettings,
  saveProfile,
  settingsFromForm,
  shapeProfileForm,
  wantsJson,
  type AccountSettings,
  type OwnerSession,
  type ProfilePostContext,
} from '../../src/lib/driverAccount';
import { changeEmail, classifyChangeEmailError, getUser, normaliseEmail } from '../../src/lib/auth';

const env = { url: 'https://project.example.test', anonKey: 'anon-key' };
const USER_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const DRIVER_ID = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'user-token';
const OWN_EMAIL = 'dana@example.test';
const NEW_EMAIL = 'new.dana@example.test';
const ORIGIN = 'https://atc.example.test';
const session: OwnerSession = { accessToken: TOKEN, user: { id: USER_ID, email: OWN_EMAIL, newEmail: null } };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const respond = (body: unknown, status = 200) =>
  new Response(body === null ? null : typeof body === 'string' ? body : JSON.stringify(body), { status });

/** Stubs fetch with a handler and records every call. */
function stubFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const call: Call = {
        url: String(input),
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body,
      };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

/** Every argument passed to console.error/warn/info, as text, so tests can check no address is logged. */
function captureLogs(): () => string {
  const spies = (['error', 'warn', 'info'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  );
  return () => spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join(' ');
}

const settings = (overrides: Partial<AccountSettings> = {}): AccountSettings => ({
  ...DEFAULT_ACCOUNT_SETTINGS,
  ...overrides,
});

const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'me.png', { type: 'image/png' });

const isSettingsUpsert = (c: Call) => c.url.includes('/rest/v1/account_settings') && c.method === 'POST';
const isUpload = (c: Call) => c.url.includes('/storage/v1/object/photos/') && c.method === 'POST';
const isDelete = (c: Call) => c.method === 'DELETE';
const isProfileRpc = (c: Call) => c.url.endsWith('/rest/v1/rpc/update_my_driver_profile');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('account settings read and write (C3, NFR1.2)', () => {
  it('reads the own row and treats a missing row as every choice off', async () => {
    const calls = stubFetch(() => respond([]));
    expect(await getMySettings(env, TOKEN, USER_ID)).toEqual(DEFAULT_ACCOUNT_SETTINGS);
    expect(calls[0].url).toContain(`/rest/v1/account_settings?profile_id=eq.${USER_ID}&select=hide_profile,`);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);

    stubFetch(() => respond([{ hide_name: true, notify_event_reminders: true, hide_profile: 'yes' }]));
    expect(await getMySettings(env, TOKEN, USER_ID)).toEqual(
      settings({ hide_name: true, notify_event_reminders: true }),
    );
  });

  it('throws UNKNOWN when the read fails, logging the action only', async () => {
    const logs = captureLogs();
    stubFetch(() => respond({ message: 'boom' }, 500));
    await expect(getMySettings(env, TOKEN, USER_ID)).rejects.toMatchObject({ code: 'UNKNOWN' });
    stubFetch(() => Promise.reject(new TypeError('network down')));
    await expect(getMySettings(env, TOKEN, USER_ID)).rejects.toBeInstanceOf(DriverAccountError);
    expect(logs()).toContain('get-settings failed');
  });

  it('upserts the five choices on the session user’s own row', async () => {
    const calls = stubFetch(() => respond(null, 201));
    await saveMySettings(env, TOKEN, USER_ID, settings({ hide_profile: true, notify_report_posted: true }));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${env.url}/rest/v1/account_settings?on_conflict=profile_id`);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.Prefer).toBe('resolution=merge-duplicates,return=minimal');
    expect(JSON.parse(calls[0].body as string)).toEqual({
      profile_id: USER_ID,
      hide_profile: true,
      hide_name: false,
      notify_appeal_reviewed: false,
      notify_report_posted: true,
      notify_event_reminders: false,
    });
  });

  it('reads checkboxes from a form (ticked present, unticked absent) and rows defensively', () => {
    const form = new FormData();
    form.set('hide_name', 'on');
    form.set('notify_appeal_reviewed', 'on');
    form.set('profile_id', 'someone-else');
    expect(settingsFromForm(form)).toEqual(settings({ hide_name: true, notify_appeal_reviewed: true }));
    expect(parseAccountSettings(null)).toEqual(DEFAULT_ACCOUNT_SETTINGS);
    expect(parseAccountSettings({ hide_profile: 1 })).toEqual(DEFAULT_ACCOUNT_SETTINGS);
  });

  it('maps a used email minute to RATE_LIMITED (claim_email_action)', async () => {
    const calls = stubFetch(() =>
      respond({ code: 'P0001', message: 'RATE_LIMITED: Too many requests. Try again in a minute' }, 400),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(claimEmailAction(env, TOKEN)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(calls[0].url).toBe(`${env.url}/rest/v1/rpc/claim_email_action`);
    stubFetch(() => respond(true));
    await expect(claimEmailAction(env, TOKEN)).resolves.toBeUndefined();
  });
});

describe('saveProfile (NFR4.1-NFR4.3)', () => {
  const input = (overrides: Partial<Parameters<typeof saveProfile>[2]> = {}) => ({
    userId: USER_ID,
    driverId: DRIVER_ID,
    bio: 'Fast in the rain.',
    photo: png() as File | null,
    settings: settings({ hide_profile: true }) as AccountSettings | null,
    ...overrides,
  });

  it('saves settings first, then uploads the photo, then updates the profile with its URL', async () => {
    const calls = stubFetch(() => respond(null, 200));
    expect(await saveProfile(env, TOKEN, input())).toEqual({ ok: true });
    expect(
      calls.map((c) =>
        isSettingsUpsert(c) ? 'settings' : isUpload(c) ? 'photo' : isProfileRpc(c) ? 'profile' : c.url,
      ),
    ).toEqual(['settings', 'photo', 'profile']);
    expect(calls[1].url).toMatch(
      new RegExp(`/storage/v1/object/photos/driver-avatars/${DRIVER_ID}/\\d+\\.png$`),
    );
    const rpc = JSON.parse(calls[2].body as string);
    expect(rpc).toMatchObject({ p_bio: 'Fast in the rain.', p_set_photo: true });
    expect(rpc.p_photo_url).toContain(`/storage/v1/object/public/photos/driver-avatars/${DRIVER_ID}/`);
  });

  it('skips the upload without a photo and the settings when they were not loaded', async () => {
    const calls = stubFetch(() => respond(null, 200));
    await saveProfile(env, TOKEN, input({ photo: null, settings: null }));
    expect(calls).toHaveLength(1);
    expect(isProfileRpc(calls[0])).toBe(true);
    expect(JSON.parse(calls[0].body as string)).toMatchObject({ p_set_photo: false, p_photo_url: null });
  });

  it('stops at a failed settings upsert before uploading anything', async () => {
    captureLogs();
    const calls = stubFetch((c) => (isSettingsUpsert(c) ? respond('nope', 500) : respond(null)));
    const result = await saveProfile(env, TOKEN, input());
    expect(result).toEqual({
      ok: false,
      step: 'settings',
      message: "Couldn't save your settings. Pick your photo again and save.",
    });
    expect(calls.some(isUpload)).toBe(false);
  });

  it('reports settings saved but photo and bio not when the upload fails', async () => {
    captureLogs();
    const calls = stubFetch((c) => (isUpload(c) ? respond('too big', 413) : respond(null)));
    const result = await saveProfile(env, TOKEN, input());
    expect(result).toMatchObject({
      ok: false,
      step: 'photo',
      message: "Your settings were saved, but your photo and bio weren't. Pick your photo again and save.",
    });
    expect(calls.some(isProfileRpc)).toBe(false);
  });

  it('deletes the uploaded photo when the profile update fails, so a retry leaves no stray file', async () => {
    const logs = captureLogs();
    const calls = stubFetch((c) => (isProfileRpc(c) ? respond('down', 503) : respond(null)));
    const result = await saveProfile(env, TOKEN, input());
    expect(result).toMatchObject({ ok: false, step: 'profile' });
    const upload = calls.find(isUpload)!;
    const deletion = calls.find(isDelete)!;
    expect(deletion.url).toBe(upload.url);
    expect(logs()).toContain('save-profile failed PROFILE');
  });

  it('still reports the failure when the clean-up delete fails too', async () => {
    const logs = captureLogs();
    stubFetch((c) => (isProfileRpc(c) || isDelete(c) ? respond('down', 503) : respond(null)));
    const result = await saveProfile(env, TOKEN, input({ photo: png() }));
    expect(result).toMatchObject({ ok: false, step: 'profile' });
    expect(logs()).toContain('delete-avatar failed');
  });

  it('words each failure for what was kept', () => {
    expect(saveFailureMessage('profile', false, true)).toBe(
      "Your settings were saved, but your photo and bio weren't. Try again.",
    );
    expect(saveFailureMessage('profile', false, false)).toBe("Couldn't save your photo and bio. Try again.");
    expect(saveFailureMessage('settings', false, true)).toBe("Couldn't save your settings. Try again.");
  });
});

describe('shapeProfileForm', () => {
  it('keeps the typed bio and choices, and knows when the choices were not loaded', () => {
    const form = new FormData();
    form.set('bio', '  Hello  ');
    form.set('hide_profile', 'on');
    form.set('settings_loaded', '1');
    expect(shapeProfileForm(form)).toMatchObject({
      ok: true,
      bio: 'Hello',
      photo: null,
      values: { bio: 'Hello', settings: settings({ hide_profile: true }) },
    });
    form.delete('settings_loaded');
    expect(shapeProfileForm(form)).toMatchObject({ ok: true, values: { settings: null } });
  });

  it('refuses a long bio and a wrong photo type, still echoing the bio', () => {
    const long = new FormData();
    long.set('bio', 'x'.repeat(501));
    expect(shapeProfileForm(long)).toMatchObject({
      ok: false,
      message: 'Your bio can be at most 500 characters.',
    });
    const gif = new FormData();
    gif.set('bio', 'Hi');
    gif.set('photo', new File(['GIF89a'], 'a.gif', { type: 'image/gif' }));
    expect(shapeProfileForm(gif)).toMatchObject({ ok: false, values: { bio: 'Hi' } });
  });
});

describe('changeEmail (NFR1.4)', () => {
  it('normalises the address and checks its format and length before calling GoTrue', async () => {
    const calls = stubFetch(() => respond({}));
    expect(normaliseEmail('  New.Dana@Example.TEST ')).toBe(NEW_EMAIL);
    for (const bad of [
      '',
      'no-at-sign',
      'a@b',
      'two words@example.test',
      `${'a'.repeat(250)}@example.test`,
      42,
    ]) {
      expect(normaliseEmail(bad), String(bad)).toBeNull();
    }
    expect(await changeEmail(env, TOKEN, 'not an email', `${ORIGIN}/drivers/x`)).toEqual({
      ok: false,
      code: 'INVALID',
    });
    expect(calls).toHaveLength(0);
  });

  it('sends PUT /auth/v1/user with the user token, the new address and the redirect target', async () => {
    const logs = captureLogs();
    const calls = stubFetch(() => respond({ id: USER_ID }));
    const redirectTo = `${ORIGIN}/drivers/${DRIVER_ID}`;
    expect(await changeEmail(env, TOKEN, ' New.Dana@example.test', redirectTo)).toEqual({
      ok: true,
      email: NEW_EMAIL,
    });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/auth/v1/user');
    expect(url.searchParams.get('redirect_to')).toBe(redirectTo);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(calls[0].body as string)).toEqual({ email: NEW_EMAIL });
    // Only the action and the redirect host: no address, no driver id.
    expect(logs()).toBe('change-email sent atc.example.test');
  });

  it.each([
    [
      422,
      { error_code: 'email_exists', msg: 'A user with this email address has already been registered' },
      'EMAIL_IN_USE',
    ],
    [422, { msg: 'Email address already registered' }, 'EMAIL_IN_USE'],
    [422, { error_code: 'validation_failed', msg: 'Unable to process request' }, 'UNKNOWN'],
    [400, { error_code: 'email_address_invalid', msg: 'Email address is invalid' }, 'INVALID'],
    [400, { msg: 'Unable to validate email address' }, 'INVALID'],
    [429, { error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' }, 'RATE_LIMITED'],
    [500, { msg: 'Internal error' }, 'UNKNOWN'],
  ] as const)('maps a %i %j to %s', async (status, body, code) => {
    expect(classifyChangeEmailError(status, JSON.stringify(body))).toBe(code);
    const logs = captureLogs();
    stubFetch(() => respond(body, status));
    expect(await changeEmail(env, TOKEN, NEW_EMAIL, `${ORIGIN}/drivers/x`)).toEqual({ ok: false, code });
    expect(logs()).toBe(`change-email failed ${code}`);
  });

  it('treats a network failure as UNKNOWN', async () => {
    captureLogs();
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    expect(await changeEmail(env, TOKEN, NEW_EMAIL, `${ORIGIN}/drivers/x`)).toEqual({
      ok: false,
      code: 'UNKNOWN',
    });
  });
});

describe('getUser (NFR1.6)', () => {
  it('returns the pending address from new_email, else null', async () => {
    stubFetch(() => respond({ id: USER_ID, email: OWN_EMAIL, new_email: NEW_EMAIL }));
    expect(await getUser(env, TOKEN)).toEqual({ id: USER_ID, email: OWN_EMAIL, newEmail: NEW_EMAIL });
    stubFetch(() => respond({ id: USER_ID, email: OWN_EMAIL }));
    expect((await getUser(env, TOKEN))?.newEmail).toBeNull();
    stubFetch(() => respond({ msg: 'expired' }, 401));
    expect(await getUser(env, TOKEN)).toBeNull();
  });
});

describe('in-place email actions (BR5.3, BR5.4)', () => {
  const isClaim = (c: Call) => c.url.endsWith('/rest/v1/rpc/claim_email_action');
  const isGoTrue = (c: Call) => c.url.includes('/auth/v1/');

  it('refuses a used minute without calling GoTrue', async () => {
    captureLogs();
    const calls = stubFetch((c) =>
      isClaim(c) ? respond({ code: 'P0001', message: 'RATE_LIMITED: Too many requests' }, 400) : respond({}),
    );
    expect(await requestEmailChange(env, session, NEW_EMAIL, `${ORIGIN}/drivers/x`)).toEqual({
      status: 'RATE_LIMITED',
      email: NEW_EMAIL,
    });
    expect(await requestOwnPasswordReset(env, session, `${ORIGIN}/reset-password`)).toBe('RATE_LIMITED');
    expect(calls.some(isGoTrue)).toBe(false);
  });

  it('refuses an invalid or unchanged address before claiming the minute', async () => {
    const calls = stubFetch(() => respond(true));
    expect((await requestEmailChange(env, session, 'nope', ORIGIN)).status).toBe('INVALID');
    expect((await requestEmailChange(env, session, ' DANA@example.test', ORIGIN)).status).toBe('SAME');
    expect(calls).toHaveLength(0);
  });

  it('resets the password for the session’s own address and maps a 429', async () => {
    const logs = captureLogs();
    const calls = stubFetch((c) => (isClaim(c) ? respond(true) : respond({})));
    expect(await requestOwnPasswordReset(env, session, `${ORIGIN}/reset-password`)).toBe('sent');
    const recover = calls.find((c) => c.url.includes('/auth/v1/recover'))!;
    expect(JSON.parse(recover.body as string)).toEqual({ email: OWN_EMAIL });
    expect(new URL(recover.url).searchParams.get('redirect_to')).toBe(`${ORIGIN}/reset-password`);

    stubFetch((c) => (isClaim(c) ? respond(true) : respond({ msg: 'rate limit' }, 429)));
    expect(await requestOwnPasswordReset(env, session, `${ORIGIN}/reset-password`)).toBe('RATE_LIMITED');
    expect(logs()).not.toContain(OWN_EMAIL);
    expect(
      await requestOwnPasswordReset(env, { ...session, user: { ...session.user, email: null } }, ORIGIN),
    ).toBe('NO_EMAIL');
  });
});

describe('the own-profile controller (NFR1.3, NFR4.2, C4)', () => {
  function context(overrides: Partial<ProfilePostContext> & { fields?: Record<string, string | File> } = {}) {
    const form = new FormData();
    form.append('intent', 'save-profile');
    for (const [name, value] of Object.entries(overrides.fields ?? {})) form.append(name, value);
    const rest: Partial<ProfilePostContext> & { fields?: unknown } = { ...overrides };
    delete rest.fields;
    return { env, session, isOwner: true, driverId: DRIVER_ID, origin: ORIGIN, json: false, form, ...rest };
  }

  it('lets only the owner post: others are redirected (or get 403 JSON) and nothing is written', async () => {
    const calls = stubFetch(() => respond({}));
    expect(await handleProfilePost(context({ isOwner: false, fields: { bio: 'hijack' } }))).toEqual({
      kind: 'redirect',
      location: `/drivers/${DRIVER_ID}`,
    });
    const json = await handleProfilePost(context({ isOwner: false, session: null, json: true }));
    expect(json).toMatchObject({ kind: 'json', status: 403, body: { ok: false } });
    expect(calls).toHaveLength(0);
  });

  it('answers an in-place action with JSON when asked, else redirects with a code-only status', async () => {
    captureLogs();
    stubFetch(() => respond(true));
    const fields = { intent: 'change-email', new_email: NEW_EMAIL };
    const json = await handleProfilePost(context({ json: true, fields }));
    expect(json).toMatchObject({ kind: 'json', status: 200, body: { ok: true } });
    expect(json.kind === 'json' && json.body.message).toContain(NEW_EMAIL);

    const redirect = await handleProfilePost(context({ fields }));
    expect(redirect).toEqual({
      kind: 'redirect',
      location: `/drivers/${DRIVER_ID}?edit=1&email_status=sent`,
    });
    expect(inPlaceStatusMessage('change-email', 'sent')?.message).not.toContain('@');

    stubFetch(() => respond({ code: 'P0001', message: 'RATE_LIMITED: Too many requests' }, 400));
    const limited = await handleProfilePost(context({ json: true, fields: { intent: 'reset-password' } }));
    expect(limited).toMatchObject({ kind: 'json', status: 429, body: { ok: false } });
  });

  it('re-renders a failed save in editing mode with the typed bio and choices', async () => {
    captureLogs();
    stubFetch((c) => (isProfileRpc(c) ? respond('down', 503) : respond(null)));
    const outcome = await handleProfilePost(
      context({ fields: { bio: 'Typed bio', hide_name: 'on', settings_loaded: '1', photo: png() } }),
    );
    expect(outcome).toMatchObject({
      kind: 'render',
      status: 502,
      editing: { bio: 'Typed bio', settings: settings({ hide_name: true }) },
    });
    expect(outcome.kind === 'render' && outcome.editing.error).toContain('Pick your photo again');
  });

  it('redirects a successful save to the saved notice', async () => {
    stubFetch(() => respond(null));
    expect(await handleProfilePost(context({ fields: { bio: 'Hi' } }))).toEqual({
      kind: 'redirect',
      location: `/drivers/${DRIVER_ID}?saved=1`,
    });
  });

  it('lets an in-place button’s intent win over the form’s save-profile default', () => {
    expect(resolveProfileIntent(['save-profile', 'change-email'])).toBe('change-email');
    expect(resolveProfileIntent(['save-profile'])).toBe('save-profile');
    expect(resolveProfileIntent([])).toBe('save-profile');
    expect(resolveProfileIntent(['delete-everything'])).toBeNull();
    expect(wantsJson('application/json')).toBe(true);
    expect(wantsJson('text/html,application/xhtml+xml')).toBe(false);
    expect(wantsJson(null)).toBe(false);
  });
});

describe('the owner render (NFR3.1)', () => {
  it('adds one call (the settings row) when the session already carries the pending email', async () => {
    const calls = stubFetch(() => respond([{ hide_profile: true }]));
    const data = await loadOwnerProfile(env, { ...session, user: { ...session.user, newEmail: NEW_EMAIL } });
    expect(calls).toHaveLength(1);
    expect(data).toEqual({
      settings: settings({ hide_profile: true }),
      settingsLoaded: true,
      email: OWN_EMAIL,
      pendingEmail: NEW_EMAIL,
    });
  });

  it('reads the auth user once more after a token refresh, and survives a failed settings read', async () => {
    captureLogs();
    const calls = stubFetch((c) =>
      c.url.includes('/auth/v1/user')
        ? respond({ id: USER_ID, email: OWN_EMAIL, new_email: NEW_EMAIL })
        : respond('down', 500),
    );
    const refreshed: OwnerSession = { accessToken: TOKEN, user: { id: USER_ID, email: OWN_EMAIL } };
    const data = await loadOwnerProfile(env, refreshed);
    expect(calls).toHaveLength(2);
    expect(data).toMatchObject({
      settingsLoaded: false,
      pendingEmail: NEW_EMAIL,
      settings: DEFAULT_ACCOUNT_SETTINGS,
    });
  });
});
