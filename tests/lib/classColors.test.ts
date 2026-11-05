/**
 * Class badge images (FR5.1-FR5.4; BR5.1): Alpha, Gamma and Delta show their badge at 1x and 2x with the
 * class name as alt text; any other class keeps its letter.
 */
import { describe, expect, it } from 'vitest';
import { classBadgeImage, classBadgeLetter } from '../../src/lib/classColors';

describe('classBadgeImage', () => {
  it('gives each league class its 64 and 128 pixel WebP badge', () => {
    for (const name of ['Alpha', 'Gamma', 'Delta']) {
      const slug = name.toLowerCase();
      expect(classBadgeImage(name)).toEqual({
        src: `/images/classes/${slug}-64.webp`,
        srcset: `/images/classes/${slug}-64.webp 1x, /images/classes/${slug}-128.webp 2x`,
        alt: name,
      });
    }
  });

  it('ignores letter case and surrounding spaces, keeping the name as written for the alt text', () => {
    expect(classBadgeImage(' ALPHA ')).toMatchObject({ src: '/images/classes/alpha-64.webp', alt: 'ALPHA' });
    expect(classBadgeImage('delta')?.alt).toBe('delta');
  });

  it('gives nothing for any other class, so the letter badge is kept', () => {
    for (const name of ['Beta', '', null, undefined, 'constructor', '__proto__', 'alpha2']) {
      expect(classBadgeImage(name)).toBeNull();
    }
    expect(classBadgeLetter('Beta')).toBe('B');
  });
});
