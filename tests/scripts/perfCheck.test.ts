/**
 * The pure helpers behind scripts/perf-check.mjs (perf-measurement U1; BR1.2, BR1.3, BR2.1, BR3.1, BR3.2,
 * BR4.1). The browser and network side is proven by the dry run and the baseline run.
 */
import { describe, expect, it } from 'vitest';
import {
  assertSafeBase,
  cacheStatesFromDevtoolsLog,
  checkFragmentUrl,
  classifyLcp,
  comparisonWarnings,
  floorNote,
  fragmentUrlFromHtml,
  judgeTargets,
  median,
  probablyUncached,
  renderComparison,
  renderReport,
} from '../../scripts/perfCheckLib.mjs';

type Run = Record<string, unknown>;
type Timing = Record<string, unknown>;

const CONTENT = { selector: 'table.w-full > tbody > tr', snippet: '<tr class="border-b">' };
const SKELETON = {
  selector: 'div.grid > div.h-24.animate-pulse',
  snippet: '<div class="h-24 animate-pulse">',
};

function run(preset: string, n: number, over: Run = {}): Run {
  return {
    preset,
    run: n,
    lcpMs: 1500,
    cls: 0.01,
    tbtMs: 100,
    lcpElement: CONTENT,
    lcpClass: 'content',
    unusedJsSavingsMs: 0,
    renderBlockingSavingsMs: 0,
    opportunities: [],
    error: null,
    ...over,
  };
}

function timing(attempt: string, over: Timing = {}): Timing {
  return {
    url: 'https://x.test/a',
    attempt,
    status: 200,
    ttfbMs: 100,
    totalMs: 150,
    bytes: 10,
    xAtcCache: 'HIT',
    ...over,
  };
}

function page(
  over: { label?: string; mobile?: Run[]; desktop?: Run[]; page?: Timing[]; fragment?: Timing[] } = {},
) {
  return {
    label: over.label ?? 'standings',
    path: '/standings',
    fragmentUrl: 'https://x.test/standings/fragment',
    runs: {
      mobile: over.mobile ?? [run('mobile', 1), run('mobile', 2), run('mobile', 3)],
      desktop: over.desktop ?? [run('desktop', 1), run('desktop', 2), run('desktop', 3)],
    },
    timings: {
      page: over.page ?? [timing('first'), timing('second')],
      fragment: over.fragment ?? [timing('first', { xAtcCache: 'MISS', ttfbMs: 900 }), timing('second')],
    },
  };
}

const status = (p: ReturnType<typeof page>, id: string) => judgeTargets(p).find((v) => v.id === id)?.status;

describe('perf-check helpers', () => {
  it('takes the median of three runs (BR1.2)', () => {
    expect(median([3000, 1000, 2000])).toEqual({ value: 2000, used: 3, total: 3 });
  });

  it('leaves a failed run out of the median and shows the count (BR1.2)', () => {
    expect(median([1000, null, 2000])).toEqual({ value: 1500, used: 2, total: 3 });
    expect(median([null, undefined])).toEqual({ value: null, used: 0, total: 2 });
  });

  it('classes an animate-pulse snippet as skeleton (BR1.3)', () => {
    expect(
      classifyLcp({ selector: 'div.mt-6 > div', snippet: '<div class="h-6 w-1/3 animate-pulse rounded">' }),
    ).toBe('skeleton');
  });

  it('classes a node under an aria-busy wrapper as skeleton (BR1.3)', () => {
    expect(classifyLcp({ selector: 'div[aria-busy="true"] > div.h-6', snippet: '<div class="h-6">' })).toBe(
      'skeleton',
    );
    expect(
      classifyLcp({
        selector: 'div.mt-8',
        snippet: '<div class="mt-8" aria-live="polite" aria-busy="true">',
      }),
    ).toBe('skeleton');
  });

  it('classes a real table row as content, and no element as unknown (BR1.3)', () => {
    expect(classifyLcp(CONTENT)).toBe('content');
    expect(classifyLcp(null)).toBe('unknown');
  });

  it('judges every target at its boundary (BR3.2)', () => {
    const at = page({
      mobile: [1, 2, 3].map((n) =>
        run('mobile', n, { lcpMs: 2500, cls: 0.1, tbtMs: 200, unusedJsSavingsMs: 149 }),
      ),
      desktop: [1, 2, 3].map((n) => run('desktop', n, { lcpMs: 2000 })),
      page: [timing('first'), timing('second', { ttfbMs: 200 })],
      fragment: [timing('first', { xAtcCache: 'MISS', ttfbMs: 1500 }), timing('second', { ttfbMs: 200 })],
    });
    for (const id of ['NFR1', 'NFR2', 'NFR3 page', 'NFR3 fragment', 'NFR4', 'NFR5'])
      expect(status(at, id), id).toBe('pass');

    const over = page({
      mobile: [1, 2, 3].map((n) => run('mobile', n, { lcpMs: 2501, unusedJsSavingsMs: 150 })),
      desktop: [1, 2, 3].map((n) => run('desktop', n, { lcpMs: 2001 })),
      page: [timing('first'), timing('second', { ttfbMs: 201 })],
      fragment: [timing('first', { xAtcCache: 'MISS', ttfbMs: 1501 }), timing('second', { ttfbMs: 201 })],
    });
    const verdicts = judgeTargets(over);
    for (const v of verdicts) {
      expect(v.status, v.id).toBe('fail');
      expect(v.cause, v.id).toBeTruthy();
    }
    expect(status(page({ mobile: [run('mobile', 1, { cls: 0.11 })] }), 'NFR1')).toBe('fail');
    expect(status(page({ mobile: [run('mobile', 1, { tbtMs: 201 })] }), 'NFR1')).toBe('fail');
    // The driver profile has the wider 2000 ms miss limit.
    const driver = page({
      label: 'driver',
      fragment: [timing('first', { xAtcCache: 'MISS', ttfbMs: 2000 })],
    });
    expect(status(driver, 'NFR4')).toBe('pass');
    expect(
      status(
        {
          ...driver,
          timings: { ...driver.timings, fragment: [timing('first', { xAtcCache: 'MISS', ttfbMs: 2001 })] },
        },
        'NFR4',
      ),
    ).toBe('fail');
  });

  it('never passes NFR4 on a cached first GET, and never passes a page whose runs all failed (BR3.1)', () => {
    for (const cache of ['HIT', 'STALE']) {
      const v = judgeTargets(page({ fragment: [timing('first', { xAtcCache: cache, ttfbMs: 50 })] })).find(
        (x) => x.id === 'NFR4',
      );
      expect(v?.status).toBe('not measured');
      expect(v?.detail).toContain('already cached');
    }
    const absent = page({ fragment: [timing('first', { xAtcCache: 'absent', ttfbMs: 50 })] });
    expect(judgeTargets(absent).find((x) => x.id === 'NFR4')?.detail).toContain('cache state unknown');
    const failed = page({ mobile: [run('mobile', 1, { error: 'timeout', lcpMs: null })] });
    expect(status(failed, 'NFR1')).toBe('not measured');
  });

  it('fails NFR2 when the median-LCP desktop run is the skeleton, even under 2000 ms (BR1.3)', () => {
    const p = page({
      desktop: [
        run('desktop', 1, { lcpMs: 900 }),
        run('desktop', 2, { lcpMs: 1200, lcpElement: SKELETON, lcpClass: 'skeleton' }),
        run('desktop', 3, { lcpMs: 1900 }),
      ],
    });
    const v = judgeTargets(p).find((x) => x.id === 'NFR2');
    expect(v?.status).toBe('fail');
    expect(v?.cause).toContain('skeleton');
  });

  it('accepts only https or a local http base URL (BR4.1)', () => {
    expect(() => assertSafeBase('http://example.com')).toThrow(/Refusing/);
    expect(() => assertSafeBase('https://user:pw@example.com')).toThrow(/credentials/);
    expect(() => assertSafeBase('not a url')).toThrow(/Not a URL/);
    expect(assertSafeBase('http://localhost:4321/')).toBe('http://localhost:4321');
    expect(assertSafeBase('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(assertSafeBase('https://alphatouringchallenge.com/x')).toBe('https://alphatouringchallenge.com');
  });

  it("reads the shell's own fragment URL, including the driver's hof flag (BR2.1)", () => {
    const shell =
      '<div data-driver-results data-fragment-url="/drivers/x/fragment?hof=1&amp;season=2"><div aria-busy="true"></div></div>';
    expect(fragmentUrlFromHtml(shell, 'https://alphatouringchallenge.com')).toBe(
      'https://alphatouringchallenge.com/drivers/x/fragment?hof=1&season=2',
    );
    expect(fragmentUrlFromHtml('<main></main>', 'https://alphatouringchallenge.com')).toBeNull();
  });

  it('renders the report and the comparison from the same data', () => {
    const report = {
      baseUrl: 'https://x.test',
      startedAt: '2026-10-22T00:00:00Z',
      commit: 'abc1234',
      lighthouseVersion: '13.5.0',
      browser: { path: 'edge', version: 'Edg/141' },
      runs: 3,
      partial: false,
      pages: [page()],
    };
    const md = renderReport(report);
    expect(md).toContain('| standings | mobile | 1500 ms (3/3)');
    expect(md).toContain('| standings | NFR4 | PASS |');
    const slower = { ...report, pages: [page({ mobile: [run('mobile', 1, { lcpMs: 1800 })] })] };
    expect(renderComparison(report, slower)).toContain(
      '| standings | Mobile LCP | 1500 ms | 1800 ms | +300 ms |',
    );
  });
});

const REPORT = {
  baseUrl: 'https://x.test',
  startedAt: '2026-10-23T01:25:48.177Z',
  commit: 'abc1234',
  lighthouseVersion: '13.5.0',
  browser: { path: 'edge', version: 'Edg/155' },
  runs: 3,
  partial: false,
  cacheWarming: true,
  pages: [] as ReturnType<typeof page>[],
};

describe('perf-check review fixes', () => {
  it('shows min and max beside each median in the report and the comparison', () => {
    const spreadPage = page({
      mobile: [
        run('mobile', 1, { lcpMs: 1400 }),
        run('mobile', 2, { lcpMs: 1500 }),
        run('mobile', 3, { lcpMs: 2100 }),
      ],
    });
    const md = renderReport({ ...REPORT, pages: [spreadPage] });
    expect(md).toContain('| standings | mobile | 1500 ms (3/3) 1400 ms–2100 ms |');
    const after = { ...REPORT, pages: [page()] };
    expect(renderComparison({ ...REPORT, pages: [spreadPage] }, after)).toContain(
      '| standings | Mobile LCP | 1500 ms | 1500 ms | +0 ms | 1400 ms–2100 ms | 1500 ms–1500 ms |',
    );
  });

  it('judges NFR3 on the median of three repeat GETs', () => {
    const repeats = (ttfbs: number[]) => [
      timing('first', { xAtcCache: 'MISS', ttfbMs: 900 }),
      ...ttfbs.map((t, i) => timing(`repeat ${i + 1}`, { ttfbMs: t })),
    ];
    // One slow outlier does not fail the median.
    const ok = page({ page: repeats([150, 900, 180]) });
    const v = judgeTargets(ok).find((x) => x.id === 'NFR3 page');
    expect(v?.status).toBe('pass');
    expect(v?.detail).toContain('median TTFB 180 ms of 3 (150 ms–900 ms)');
    expect(status(page({ page: repeats([150, 250, 260]) }), 'NFR3 page')).toBe('fail');
  });

  it('says when the client latency floor is at least half the measured TTFB', () => {
    expect(floorNote(100, 200)).toContain('client latency floor 100 ms');
    expect(floorNote(99, 200)).toBeNull();
    const slow = page({ page: [timing('first'), timing('repeat 1', { ttfbMs: 400 })] });
    const withFloor = {
      ...slow,
      timings: { ...slow.timings, floor: timing('client floor', { ttfbMs: 250 }) },
    };
    const v = judgeTargets(withFloor).find((x) => x.id === 'NFR3 page');
    expect(v?.status).toBe('fail');
    expect(v?.cause).toContain('network distance');
  });

  it('warns when the two reports are not like for like, naming the unwarmed baseline', () => {
    const before = { ...REPORT, cacheWarming: undefined, partial: true };
    const after = { ...REPORT, lighthouseVersion: '13.6.0', runs: 1, baseUrl: 'http://localhost:4321' };
    const warnings = comparisonWarnings(before, after);
    expect(warnings.join('\n')).toContain('before report (2026-10-23T01:25:48.177Z) had no cache warming');
    expect(warnings.join('\n')).toContain('partial run');
    expect(warnings.join('\n')).toMatch(
      /Lighthouse version differs.*runs per preset differs.*base URL differs/s,
    );
    expect(comparisonWarnings(REPORT, REPORT)).toEqual([]);
    expect(renderComparison(before, after)).toContain('> **Warning:**');
  });

  it('rejects a fragment URL on another origin, so it is never timed', () => {
    const base = 'https://alphatouringchallenge.com';
    const evil = fragmentUrlFromHtml('<div data-fragment-url="https://evil.test/x"></div>', base);
    const checked = checkFragmentUrl(evil, base);
    expect(checked.url).toBeNull();
    expect(checked.rejected).toContain('https://evil.test');
    expect(checkFragmentUrl(`${base}/standings/fragment`, base)).toEqual({
      url: `${base}/standings/fragment`,
      rejected: null,
    });
    const rejected = { ...page({ fragment: [] }), fragmentUrl: null, fragmentRejected: checked.rejected };
    expect(judgeTargets(rejected).find((x) => x.id === 'NFR4')?.detail).toContain('rejected');
  });

  it('classes a pointer-events-none background-image backdrop as decorative, which fails NFR2', () => {
    const backdrop = {
      selector: 'body > main > section.relative > div.pointer-events-none',
      snippet:
        '<div class="pointer-events-none absolute inset-x-0" style="background-image: url(&quot;/x.jpg&quot;);">',
    };
    expect(classifyLcp(backdrop)).toBe('decorative');
    expect(
      classifyLcp({ selector: 'div.pointer-events-none', snippet: '<div class="pointer-events-none">' }),
    ).toBe('content');
    const p = page({
      desktop: [run('desktop', 1, { lcpMs: 900, lcpElement: backdrop, lcpClass: 'decorative' })],
    });
    expect(status(p, 'NFR2')).toBe('fail');
    expect(renderReport({ ...REPORT, pages: [p] })).toContain('classed `decorative`');
  });

  it('notes a fragment that sends no X-ATC-Cache and is as slow on repeat as on first GET', () => {
    const fragment = [
      timing('first', { xAtcCache: 'absent', ttfbMs: 8856 }),
      timing('repeat 1', { xAtcCache: 'absent', ttfbMs: 8727 }),
    ];
    expect(probablyUncached(fragment)).toBe(true);
    expect(probablyUncached([fragment[0], timing('repeat 1', { xAtcCache: 'absent', ttfbMs: 300 })])).toBe(
      false,
    );
    const v = judgeTargets(page({ label: 'driver', fragment })).find((x) => x.id === 'NFR4');
    expect(v?.detail).toContain('probably uncached');
  });

  it('reads the document and fragment X-ATC-Cache from a DevTools log', () => {
    const log = [
      {
        method: 'Network.requestWillBeSent',
        params: { requestId: '1', request: { url: 'https://x.test/' } },
      },
      {
        method: 'Network.responseReceived',
        params: { requestId: '1', response: { url: 'https://x.test/', headers: { 'X-ATC-Cache': 'HIT' } } },
      },
      {
        method: 'Network.requestWillBeSent',
        params: { requestId: '2', request: { url: 'https://x.test/home/fragment' } },
      },
      {
        method: 'Network.responseReceivedExtraInfo',
        params: { requestId: '2', headers: { 'x-atc-cache': 'STALE' } },
      },
    ];
    expect(cacheStatesFromDevtoolsLog(log, 'https://x.test/', 'https://x.test/home/fragment')).toEqual({
      document: 'HIT',
      fragment: 'STALE',
    });
    expect(cacheStatesFromDevtoolsLog([], 'https://x.test/', null)).toEqual({
      document: null,
      fragment: null,
    });
  });
});
