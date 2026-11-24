/**
 * Layout categories and logo colours (src/lib/circuitCategory.ts; BR1.1, BR1.3, BR1.4, FR5.3.2): the keys,
 * labels and order, the colour parser's accepted and refused inputs, and the layout readers asking the view
 * for category. PostgREST is stubbed through fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LAYOUT_CATEGORIES,
  LAYOUT_CATEGORY_LABELS,
  LAYOUT_CATEGORY_ORDER,
  formatLayoutSubtitle,
  isLayoutCategory,
  isStoredLogoColour,
  normaliseLogoColour,
} from '../../src/lib/circuitCategory';
import { getCircuitLayoutById, getCircuitLayouts, logoBgAttrs } from '../../src/lib/db/circuits';

const env = { url: 'https://project.supabase.co', anonKey: 'anon-key' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('layout categories', () => {
  it('accepts every stored key', () => {
    for (const key of ['oval', 'roval', 'road_long', 'road_short', 'street']) {
      expect(isLayoutCategory(key)).toBe(true);
    }
  });

  it('refuses unknown keys, wrong case, empty values and non-strings', () => {
    for (const value of ['Oval', '', 'gravel', ' oval', null, undefined, 1, {}]) {
      expect(isLayoutCategory(value)).toBe(false);
    }
  });

  it('labels exactly the keys, in the fixed order', () => {
    expect(LAYOUT_CATEGORIES).toEqual(['oval', 'roval', 'road_long', 'road_short', 'street']);
    expect(LAYOUT_CATEGORY_ORDER).toEqual(LAYOUT_CATEGORIES);
    expect(Object.keys(LAYOUT_CATEGORY_LABELS).sort()).toEqual([...LAYOUT_CATEGORIES].sort());
    expect(LAYOUT_CATEGORIES.map((k) => LAYOUT_CATEGORY_LABELS[k])).toEqual([
      'Oval',
      'Roval',
      'Road Course (Long)',
      'Road Course (Short)',
      'Street Course',
    ]);
  });
});

describe('normaliseLogoColour', () => {
  it('returns lower-case #rrggbb for hex input, expanding the short form', () => {
    expect(normaliseLogoColour('#FFF')).toBe('#ffffff');
    expect(normaliseLogoColour('#A1b2C3')).toBe('#a1b2c3');
    expect(normaliseLogoColour(' #abc ')).toBe('#aabbcc');
  });

  it('converts rgb() with components from 0 to 255, any case and spacing', () => {
    expect(normaliseLogoColour('rgb(255, 0, 0)')).toBe('#ff0000');
    expect(normaliseLogoColour('RGB( 0,128 ,  255 )')).toBe('#0080ff');
    expect(normaliseLogoColour('rgb(0,0,0)')).toBe('#000000');
  });

  it('refuses out-of-range components, names, wrong lengths and anything with extra text', () => {
    for (const value of [
      'rgb(256,0,0)',
      'rgb(-1,0,0)',
      'rgb(1.5,0,0)',
      'rgba(0,0,0,1)',
      'red',
      '#abcd',
      '#abcdefa',
      '#ggg',
      'abcdef',
      'url(x)',
      '#fff;color:red',
      '',
      '   ',
      null,
      undefined,
      0xffffff,
    ]) {
      expect(normaliseLogoColour(value)).toBeNull();
    }
  });

  it('only ever returns # plus six lower-case hex digits', () => {
    for (const value of ['#FfF', 'rgb(10, 20, 30)', '#123456']) {
      expect(normaliseLogoColour(value)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('isStoredLogoColour', () => {
  it('accepts only # plus six lower-case hex digits', () => {
    expect(isStoredLogoColour('#4369f5')).toBe(true);
  });

  it('refuses upper case, the short form, names, extra text and non-strings', () => {
    for (const value of ['#4369F5', '#abc', 'light', '#4369f5;x', '#4369f5 ', '', null, 0x4369f5]) {
      expect(isStoredLogoColour(value)).toBe(false);
    }
  });
});

describe('formatLayoutSubtitle', () => {
  it('joins length and corners (AC5.6.1)', () => {
    expect(formatLayoutSubtitle(5.79, 19)).toBe('5.79 km, 19 corners');
  });

  it('says "1 corner" and "0 corners" (AC5.6.2)', () => {
    expect(formatLayoutSubtitle(null, 1)).toBe('1 corner');
    expect(formatLayoutSubtitle(null, 0)).toBe('0 corners');
  });

  it('leaves out a missing part, and gives null when both are missing (AC5.6.3)', () => {
    expect(formatLayoutSubtitle(3.2, null)).toBe('3.2 km');
    expect(formatLayoutSubtitle(null, 12)).toBe('12 corners');
    expect(formatLayoutSubtitle(null, null)).toBeNull();
  });

  it('rounds half up to at most three decimals and drops trailing zeros (AC5.6.4)', () => {
    expect(formatLayoutSubtitle(4.0235, null)).toBe('4.024 km');
    expect(formatLayoutSubtitle(5.79, null)).toBe('5.79 km');
    expect(formatLayoutSubtitle(4, null)).toBe('4 km');
  });
});

describe('logoBgAttrs', () => {
  it('draws light and dark plates as before; the custom plate is pinned in logoPlate.test.ts', () => {
    expect(logoBgAttrs('light')).toEqual({ 'data-logo-bg': 'light' });
    expect(logoBgAttrs('dark')).toEqual({ 'data-logo-bg': 'dark' });
    expect(logoBgAttrs(null)).toEqual({});
  });
});

describe('layout readers', () => {
  it('ask circuit_layouts_shown for category, last', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await getCircuitLayouts(env, 'c1');
    await getCircuitLayoutById(env, 'l1');
    for (const call of fetchMock.mock.calls as [string][]) {
      const url = new URL(call[0]);
      expect(url.pathname).toBe('/rest/v1/circuit_layouts_shown');
      const columns = url.searchParams.get('select')!.split(',');
      expect(columns.at(-1)).toBe('category');
      expect(columns).toContain('lap_record_holder');
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
