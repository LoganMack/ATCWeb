/**
 * Class badge images (FR5; BR5.1): the six WebP files exist and stay small, every one-letter class marker goes
 * through ClassBadge, and the profile header keeps its named class icon before the flag.
 */
import { beforeAll, describe, expect, it } from 'vitest';

const SRC = import.meta.glob('/src/**/*.{astro,ts}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
// A lazy glob is only used for its keys, which list the image files that exist.
const IMAGE_FILES = Object.keys(import.meta.glob('/public/images/classes/*'));

const COMPONENT = '/src/components/ClassBadge.astro';

// Sizes are read from disk; the specifier is a plain string because the project has no Node type definitions.
const sizes = new Map<string, number>();
const header = new Map<string, string>();
beforeAll(async () => {
  const fs = await import('node:fs/promises' as string);
  for (const path of IMAGE_FILES) {
    const bytes: Uint8Array = await fs.readFile(new URL(`../..${path}`, import.meta.url));
    sizes.set(path, bytes.length);
    header.set(path, String.fromCharCode(...bytes.slice(8, 12)));
  }
});

describe('class badge images', () => {
  it('has a 64 px and a 128 px WebP for each class, each under 10 KB', () => {
    expect(IMAGE_FILES.map((p) => p.replace('/public/images/classes/', '')).sort()).toEqual([
      'alpha-128.webp',
      'alpha-64.webp',
      'delta-128.webp',
      'delta-64.webp',
      'gamma-128.webp',
      'gamma-64.webp',
    ]);
    for (const path of IMAGE_FILES) {
      expect(header.get(path), path).toBe('WEBP');
      expect(sizes.get(path), path).toBeLessThan(10 * 1024);
    }
  });
});

describe('ClassBadge', () => {
  it('renders the image with both sizes and the class name, falling back to the letter', () => {
    const badge = SRC[COMPONENT];
    expect(badge).toContain('srcset={image.srcset}');
    expect(badge).toContain("alt={decorative ? '' : image.alt}");
    expect(badge).toContain('{classBadgeLetter(name)}');
  });

  it('is the only place outside classColors.ts that renders a class letter', () => {
    const users = Object.entries(SRC)
      .filter(
        ([path, text]) =>
          path !== COMPONENT && path !== '/src/lib/classColors.ts' && text.includes('classBadgeLetter'),
      )
      .map(([path]) => path);
    expect(users).toEqual([]);
  });

  it('is used at every former one-letter spot', () => {
    for (const page of [
      '/src/pages/briefing/[eventId].astro',
      '/src/pages/circuits/layout-detail/[layoutId].astro',
      '/src/pages/drivers/[id]/fragment.astro',
      '/src/pages/drivers/[id].astro',
      '/src/pages/team-stats/fragment.astro',
      '/src/pages/results/fragment.astro',
    ]) {
      expect(SRC[page], page).toMatch(/<ClassBadge\b/);
    }
  });

  it('keeps the profile header class icon named and before the flag', () => {
    const shell = SRC['/src/pages/drivers/[id].astro'];
    const icon = shell.indexOf('data-testid="driver-class-icon"');
    expect(icon).toBeGreaterThan(-1);
    expect(shell.indexOf('<ClassBadge className={className} size="lg" decorative />')).toBeGreaterThan(icon);
    expect(shell.indexOf('<DriverFlag', icon)).toBeGreaterThan(icon);
  });
});
