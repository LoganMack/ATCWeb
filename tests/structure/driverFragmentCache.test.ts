/**
 * The driver profile fragment declares the shared public-fragment cache header, and a failed load still makes
 * it uncacheable (BR1.1, BR1.2).
 */
import { describe, expect, it } from 'vitest';
import FRAGMENT from '../../src/pages/drivers/[id]/fragment.astro?raw';

const SHARED_HEADER =
  "Astro.response.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');";

/** The frontmatter only: the code that runs before the markup. */
function frontmatter(source: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!match) throw new Error('fragment.astro has no frontmatter');
  return match[1];
}

describe('driver profile fragment cache header', () => {
  it('sets the shared header, and a load failure still calls markUncacheable after it', () => {
    const code = frontmatter(FRAGMENT);
    const headerAt = code.indexOf(SHARED_HEADER);
    const uncacheableAt = code.indexOf('if (loadError) markUncacheable(Astro);');
    expect(headerAt).toBeGreaterThan(-1);
    expect(uncacheableAt).toBeGreaterThan(-1);
    // markUncacheable must run last so its no-store wins over the shared header.
    expect(uncacheableAt).toBeGreaterThan(headerAt);
  });
});
