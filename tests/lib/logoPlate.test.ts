/**
 * The custom logo plate (circuit-editor BR1.9, BR1.10, BR1.17, NFR7.2, NFR7.3): logoBgAttrs is the one place
 * that renders a plate, and only a strict stored colour reaches its inline `--logo-bg`; the stored-value read
 * keeps the same single request and drops anything else; a layout PATCH that matched no row resolves to
 * undefined. PostgREST is stubbed through fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCircuitLogoBackgrounds, logoBgAttrs, updateCircuitLayout } from '../../src/lib/db/circuits';

const env = { url: 'https://project.supabase.co', anonKey: 'anon-key' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('logoBgAttrs', () => {
  it('keeps the light and dark plates unchanged', () => {
    expect(logoBgAttrs('light')).toEqual({ 'data-logo-bg': 'light' });
    expect(logoBgAttrs('dark')).toEqual({ 'data-logo-bg': 'dark' });
  });

  it('renders a stored colour as the custom plate, exactly', () => {
    expect(logoBgAttrs('#4369f5')).toEqual({ 'data-logo-bg': 'custom', style: '--logo-bg:#4369f5' });
  });

  it('renders nothing for any other value', () => {
    for (const value of ['#FFF', 'red', '#fff;color:red', 'url(x)', '#4369f5 ', null, undefined]) {
      expect(logoBgAttrs(value as Parameters<typeof logoBgAttrs>[0])).toEqual({});
    }
  });
});

describe('getCircuitLogoBackgrounds', () => {
  it('keeps light, dark and stored colours, and drops the rest, in one request', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify([
            { id: 'a', logo_background: 'light' },
            { id: 'b', logo_background: 'dark' },
            { id: 'c', logo_background: '#4369f5' },
            { id: 'd', logo_background: '#ABC' },
            { id: 'e', logo_background: 'red' },
          ]),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await getCircuitLogoBackgrounds(env)).toEqual({ a: 'light', b: 'dark', c: '#4369f5' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/rest/v1/circuits');
    expect(url.searchParams.get('select')).toBe('id,logo_background');
    expect(url.searchParams.get('logo_background')).toBe('not.is.null');
  });

  it('gives an empty map when the request fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    expect(await getCircuitLogoBackgrounds(env)).toEqual({});
  });
});

describe('updateCircuitLayout', () => {
  it('resolves to undefined when the PATCH matched no row, sending only the keys passed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const saved = await updateCircuitLayout(env, 'token', 'l-1', {
      name: 'GP',
      category: 'oval',
      length_km: null,
      corners: 4,
    });
    expect(saved).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(new URL(url).searchParams.get('id')).toBe('eq.l-1');
    expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual(['category', 'corners', 'length_km', 'name']);
  });
});
