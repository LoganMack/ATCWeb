/**
 * The move check's self-test (functional spec W4.7; BR1.1). scripts/move-check.mjs proves each split
 * moved code token for token; this proves the check itself reports each planted kind of change. The
 * check of a real split runs from the command line against the PR's base commit:
 *   node scripts/move-check.mjs src/lib/penalties.ts
 */
import { describe, expect, it } from 'vitest';
import { applyRewrites, runSelfTest, sourceTokens } from '../../scripts/move-check.mjs';

const selfTest = runSelfTest();

describe('move check self-test (W4.7)', () => {
  it.each(selfTest.baselines.map((b) => [b.name, b] as const))('reports no difference for the %s', (_, b) => {
    expect(b.result.differences).toEqual([]);
  });

  it('plants all six required cases, plus a page handler-move case', () => {
    expect(selfTest.cases.map((c) => c.name)).toEqual([
      'a one-token change',
      'an inserted statement',
      'a deleted }',
      'a duplicated declaration',
      'a missing declaration',
      'an unlisted rewrite',
      'a changed shared closure',
    ]);
  });

  it.each(selfTest.cases.map((c) => [c.name, c] as const))('catches %s', (_, c) => {
    expect(c.caught, c.result.differences.join('\n')).toBe(true);
  });
});

describe('named token rewrites', () => {
  const tokens = (src: string) => sourceTokens('x.ts', src);

  it('rewrites a redirect with a placeholder and counts each use', () => {
    const rules = [{ name: 'astro-redirect', from: 'Astro.redirect(X, 302)', to: 'ctx.redirect(X)' }];
    const out = applyRewrites(
      tokens('return Astro.redirect(`${a}#b`, 302); Astro.redirect(f(1, 2), 302);'),
      rules,
    );
    expect(out.tokens.map((t: { text: string }) => t.text).join(' ')).toBe(
      'return ctx . redirect ( `${ a }#b` ) ; ctx . redirect ( f ( 1 , 2 ) ) ;',
    );
    expect(out.counts.get('astro-redirect')).toBe(2);
  });

  it('rewrites inside a placeholder as well', () => {
    const rules = [
      { name: 'astro-redirect', from: 'Astro.redirect(X, 302)', to: 'ctx.redirect(X)' },
      { name: 'astro-url', from: 'Astro.url', to: 'ctx.url' },
    ];
    const out = applyRewrites(tokens('Astro.redirect(`${p}${Astro.url.search}`, 302);'), rules);
    expect(out.tokens.map((t: { text: string }) => t.text).join(' ')).toBe(
      'ctx . redirect ( `${ p }${ ctx . url . search }` ) ;',
    );
    expect(out.counts.get('astro-url')).toBe(1);
  });

  it('leaves a redirect with another status alone', () => {
    const rules = [{ name: 'astro-redirect', from: 'Astro.redirect(X, 302)', to: 'ctx.redirect(X)' }];
    const out = applyRewrites(tokens('Astro.redirect(a, 303);'), rules);
    expect(out.counts.get('astro-redirect')).toBe(0);
  });
});
