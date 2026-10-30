/**
 * The Content-Security-Policy stays as it is for incident clips (BR5.5): it sets no frame, media, child or
 * default source, so the YouTube embed and direct video files already play, and adding one would block them
 * (or, for default-src, much more). Its tight directives stay in place.
 */
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, newCspNonce } from '../../src/lib/csp';

const directives = (policy: string) => policy.split(';').map((d) => d.trim().split(/\s+/)[0]);

describe('contentSecurityPolicy and clips', () => {
  it('sets no frame-src, child-src, media-src or default-src', () => {
    const names = directives(contentSecurityPolicy(newCspNonce()));
    for (const name of ['frame-src', 'child-src', 'media-src', 'default-src']) {
      expect(names).not.toContain(name);
    }
  });

  it("keeps object-src 'none' and frame-ancestors 'self'", () => {
    const policy = contentSecurityPolicy('abc');
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'self'");
  });

  it('keeps the script allow-list without unsafe-inline or unsafe-eval', () => {
    const policy = contentSecurityPolicy('abc');
    expect(policy).toMatch(/script-src 'self' /);
    expect(policy).toContain("'nonce-abc'");
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval/);
  });
});
