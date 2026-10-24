/**
 * Sign-up outcomes (U1 account-onboarding, US1.1): how a GoTrue /signup response is classified (BR1.2,
 * BR1.4, BR1.6) and what signUp() sends (BR1.1, NFR3.3). Synthetic GoTrue bodies only; fetch is stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifySignUpResponse, signUp } from '../../src/lib/auth';

const env = { url: 'https://project.example.test', anonKey: 'anon-key' } as Parameters<typeof signUp>[0];

const json = (body: unknown) => JSON.stringify(body);

const newUserBody = {
  id: 'u-new',
  email: 'new@example.test',
  identities: [{ identity_id: 'i-1', provider: 'email' }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('classifySignUpResponse', () => {
  it('returns a session when GoTrue signs the new account in straight away', () => {
    const body = json({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      user: { id: 'u-1', email: 'new@example.test' },
    });
    const result = classifySignUpResponse(200, body);
    expect(result.kind).toBe('session');
    if (result.kind !== 'session') return;
    expect(result.session.accessToken).toBe('at');
    expect(result.session.refreshToken).toBe('rt');
    expect(result.session.user).toEqual({ id: 'u-1', email: 'new@example.test' });
    expect(result.session.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('asks a new address to confirm by email when the user has identities', () => {
    expect(classifySignUpResponse(200, json(newUserBody))).toEqual({ kind: 'confirm-email' });
  });

  it('reports email in use for the obfuscated user with an empty identities list', () => {
    const body = json({ id: 'u-fake', email: 'taken@example.test', identities: [] });
    expect(classifySignUpResponse(200, body)).toEqual({ kind: 'email-in-use' });
  });

  it('reports email in use for a 422 user_already_exists error', () => {
    const body = json({ code: 422, error_code: 'user_already_exists', msg: 'Something else entirely' });
    expect(classifySignUpResponse(422, body)).toEqual({ kind: 'email-in-use' });
  });

  it('reports email in use from the message alone', () => {
    expect(classifySignUpResponse(400, json({ msg: 'User already registered' }))).toEqual({
      kind: 'email-in-use',
    });
    expect(classifySignUpResponse(400, json({ message: 'A user with this email ALREADY EXISTS' }))).toEqual({
      kind: 'email-in-use',
    });
  });

  it('throws for any other failure, with GoTrue’s message', () => {
    expect(() => classifySignUpResponse(500, json({ msg: 'Database error saving new user' }))).toThrow(
      'Database error saving new user',
    );
    expect(() => classifySignUpResponse(429, 'not json')).toThrow('Request failed (429): not json');
  });

  it('treats an unknown 2xx shape as confirm-email and warns with the keys only', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = classifySignUpResponse(200, json({ id: 'u-2', email: 'secret@example.test' }));
    expect(result).toEqual({ kind: 'confirm-email' });
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain('unrecognised GoTrue response shape');
    expect(logged).toContain('email');
    expect(logged).not.toContain('secret@example.test');
  });
});

describe('signUp', () => {
  it('sends the email trimmed and lower-cased, in a single request', async () => {
    const fetchMock = vi.fn(async () => new Response(json(newUserBody), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await signUp(
      env,
      '  New.User@Example.TEST ',
      'pw-123456',
      'Nina',
      'https://site.test/login',
    );

    expect(result).toEqual({ kind: 'confirm-email' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(
      'https://project.example.test/auth/v1/signup?redirect_to=' +
        encodeURIComponent('https://site.test/login'),
    );
    const sent = JSON.parse(String(init.body));
    expect(sent.email).toBe('new.user@example.test');
    expect(sent.data).toEqual({ display_name: 'Nina' });
  });

  it('passes an email-in-use response through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(json({ error_code: 'user_already_exists' }), { status: 422 })),
    );
    await expect(signUp(env, 'taken@example.test', 'pw-123456')).resolves.toEqual({ kind: 'email-in-use' });
  });
});
