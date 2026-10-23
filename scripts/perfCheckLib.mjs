// Pure helpers for scripts/perf-check.mjs: medians, LCP classification, target verdicts, URL safety and
// the Markdown report. No network, browser or file access here, so the tests can run them directly.

export const PAGES = [
  { label: 'home', path: '/' },
  { label: 'results', path: '/results/89326124' },
  { label: 'incidents', path: '/results/89326124/incidents' },
  { label: 'standings', path: '/standings' },
  { label: 'driver', path: '/drivers/e37c3e4c-0665-4200-9892-eaf8354c7f50' },
];

// NFR1–NFR5 as agreed in requirements; every limit is inclusive except NFR5, which reads "< 150 ms".
export const TARGETS = {
  mobileLcpMs: 2500,
  mobileCls: 0.1,
  mobileTbtMs: 200,
  desktopLcpMs: 2000,
  cacheHitTtfbMs: 200,
  missTtfbMs: { driver: 2000, other: 1500 },
  frontEndSavingsMs: 150,
};

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** Median of the numeric values; failed runs (null, undefined, NaN) are left out and counted. */
export function median(values) {
  const used = values.filter(isNumber).sort((a, b) => a - b);
  const total = values.length;
  if (used.length === 0) return { value: null, used: 0, total };
  const mid = Math.floor(used.length / 2);
  const value = used.length % 2 ? used[mid] : (used[mid - 1] + used[mid]) / 2;
  return { value, used: used.length, total };
}

/** The successful run at the median of `key`; with an even count, the slower middle run (conservative). */
export function medianRun(runs, key) {
  const ok = runs.filter((r) => !r.error && isNumber(r[key])).sort((a, b) => a[key] - b[key]);
  if (ok.length === 0) return null;
  return ok[Math.ceil((ok.length - 1) / 2)];
}

/** `skeleton` when the LCP node is a pulse placeholder or sits in an aria-busy wrapper, else `content`. */
export function classifyLcp(element) {
  const selector = element?.selector ?? '';
  const snippet = element?.snippet ?? '';
  if (!selector && !snippet) return 'unknown';
  const text = `${selector}\n${snippet}`;
  if (/(^|[\s."'>])animate-pulse\b/.test(text)) return 'skeleton';
  if (/aria-busy\s*=\s*["']?true/i.test(text) || /\[aria-busy(=["']?true["']?)?\]/i.test(selector)) {
    return 'skeleton';
  }
  return 'content';
}

/** Estimated savings (ms) of a Lighthouse audit or insight; 0 when it found nothing, null when absent. */
export function auditSavingsMs(audit) {
  if (!audit || audit.scoreDisplayMode === 'error') return null;
  const candidates = [audit.details?.overallSavingsMs, audit.metricSavings?.LCP, audit.metricSavings?.FCP];
  const found = candidates.filter(isNumber);
  return found.length ? Math.max(0, ...found) : 0;
}

/** The LCP node from Lighthouse 13's LCP breakdown insight, or the older LCP-element audit. */
export function lcpElementFromLhr(lhr) {
  const nodes = [];
  const collect = (d) => {
    if (!d || typeof d !== 'object') return;
    if (d.type === 'node') nodes.push(d);
    for (const v of Object.values(d)) if (v && typeof v === 'object') collect(v);
  };
  collect(lhr?.audits?.['lcp-breakdown-insight']?.details);
  if (nodes.length === 0) collect(lhr?.audits?.['largest-contentful-paint-element']?.details);
  const node = nodes[0];
  return node
    ? { selector: node.selector ?? '', snippet: node.snippet ?? '', label: node.nodeLabel ?? '' }
    : null;
}

/** One Lighthouse result reduced to the fields the report needs. */
export function runFromLhr(lhr, preset, run) {
  const audits = lhr?.audits ?? {};
  const value = (id) => (isNumber(audits[id]?.numericValue) ? audits[id].numericValue : null);
  const lcpElement = lcpElementFromLhr(lhr);
  const opportunities = Object.values(audits)
    .map((a) => ({ id: a.id, title: a.title, savingsMs: auditSavingsMs(a) }))
    .filter((o) => isNumber(o.savingsMs) && o.savingsMs > 0)
    .sort((a, b) => b.savingsMs - a.savingsMs)
    .slice(0, 3);
  return {
    preset,
    run,
    lcpMs: value('largest-contentful-paint'),
    cls: value('cumulative-layout-shift'),
    tbtMs: value('total-blocking-time'),
    lcpElement,
    lcpClass: classifyLcp(lcpElement),
    unusedJsSavingsMs: auditSavingsMs(audits['unused-javascript']),
    renderBlockingSavingsMs: auditSavingsMs(
      audits['render-blocking-insight'] ?? audits['render-blocking-resources'],
    ),
    opportunities,
    runtimeError: lhr?.runtimeError?.message ?? null,
    error: null,
  };
}

/** Medians per preset for one page. */
export function summarizePage(page) {
  const out = {};
  for (const preset of ['mobile', 'desktop']) {
    const runs = page.runs?.[preset] ?? [];
    const ok = runs.map((r) => (r.error ? {} : r));
    out[preset] = {
      lcp: median(ok.map((r) => r.lcpMs)),
      cls: median(ok.map((r) => r.cls)),
      tbt: median(ok.map((r) => r.tbtMs)),
      unusedJs: median(ok.map((r) => r.unusedJsSavingsMs)),
      renderBlocking: median(ok.map((r) => r.renderBlockingSavingsMs)),
      lcpRun: medianRun(runs, 'lcpMs'),
    };
  }
  return out;
}

const ms = (v) => (isNumber(v) ? `${Math.round(v)} ms` : 'n/a');
const isCached = (cache) => cache === 'HIT' || cache === 'STALE';

function lcpCause(run) {
  if (!run) return 'no successful run';
  const el = run.lcpElement ? `\`${run.lcpElement.selector || run.lcpElement.label}\`` : 'unknown element';
  const top = run.opportunities?.length
    ? `; top opportunities: ${run.opportunities.map((o) => `${o.title} (${ms(o.savingsMs)})`).join(', ')}`
    : '';
  return `LCP element ${el} (${run.lcpClass})${top}`;
}

function verdict(id, target, status, detail, cause = null) {
  return { id, target, status, detail, cause };
}

/** One verdict per target (NFR1–NFR5): pass, fail with its likely cause, or not measured with the reason. */
export function judgeTargets(page) {
  const s = summarizePage(page);
  const out = [];
  const m = s.mobile;

  // NFR1: mobile medians.
  if (m.lcp.used === 0) {
    out.push(
      verdict('NFR1', 'mobile LCP ≤ 2500 ms, CLS ≤ 0.1, TBT ≤ 200 ms', 'not measured', 'every run failed'),
    );
  } else {
    const misses = [];
    if (!(m.lcp.value <= TARGETS.mobileLcpMs)) misses.push(`LCP ${ms(m.lcp.value)}`);
    if (!(m.cls.value <= TARGETS.mobileCls)) misses.push(`CLS ${m.cls.value?.toFixed(3) ?? 'n/a'}`);
    if (!(m.tbt.value <= TARGETS.mobileTbtMs)) misses.push(`TBT ${ms(m.tbt.value)}`);
    const detail = `LCP ${ms(m.lcp.value)}, CLS ${m.cls.value?.toFixed(3) ?? 'n/a'}, TBT ${ms(m.tbt.value)} (median of ${m.lcp.used}/${m.lcp.total})`;
    out.push(
      misses.length
        ? verdict(
            'NFR1',
            'mobile medians',
            'fail',
            detail,
            `${misses.join(', ')} over target; ${lcpCause(m.lcpRun)}`,
          )
        : verdict('NFR1', 'mobile medians', 'pass', detail),
    );
  }

  // NFR2: the median-LCP desktop run must be at most 2000 ms and real content.
  const d = s.desktop;
  if (!d.lcpRun) {
    out.push(verdict('NFR2', 'desktop LCP ≤ 2000 ms, real content', 'not measured', 'every run failed'));
  } else {
    const run = d.lcpRun;
    const detail = `median-LCP run ${ms(run.lcpMs)}, ${run.lcpClass} (median ${ms(d.lcp.value)} of ${d.lcp.used}/${d.lcp.total})`;
    const misses = [];
    if (!(run.lcpMs <= TARGETS.desktopLcpMs)) misses.push(`LCP ${ms(run.lcpMs)} over 2000 ms`);
    if (run.lcpClass !== 'content') misses.push(`LCP element is ${run.lcpClass}, not real content`);
    out.push(
      misses.length
        ? verdict('NFR2', 'desktop median', 'fail', detail, `${misses.join('; ')}; ${lcpCause(run)}`)
        : verdict('NFR2', 'desktop median', 'pass', detail),
    );
  }

  // NFR3: each second GET, page and fragment separately; one sample, so indicative only.
  for (const kind of ['page', 'fragment']) {
    const second = page.timings?.[kind]?.[1];
    const id = `NFR3 ${kind}`;
    if (!second || second.error || !isNumber(second.ttfbMs)) {
      out.push(
        verdict(id, 'second GET TTFB ≤ 200 ms, cache hit', 'not measured', second?.error ?? 'no request'),
      );
      continue;
    }
    const detail = `TTFB ${ms(second.ttfbMs)}, X-ATC-Cache ${second.xAtcCache} (single sample, indicative)`;
    const misses = [];
    if (!isCached(second.xAtcCache)) misses.push(`not a cache hit (X-ATC-Cache ${second.xAtcCache})`);
    if (!(second.ttfbMs <= TARGETS.cacheHitTtfbMs)) misses.push(`TTFB ${ms(second.ttfbMs)} over 200 ms`);
    if (second.status !== 200) misses.push(`status ${second.status}`);
    out.push(
      misses.length
        ? verdict(id, 'second GET', 'fail', detail, misses.join('; '))
        : verdict(id, 'second GET', 'pass', detail),
    );
  }

  // NFR4: only a first fragment GET that really missed the cache says anything about miss time.
  const limit = page.label === 'driver' ? TARGETS.missTtfbMs.driver : TARGETS.missTtfbMs.other;
  const first = page.timings?.fragment?.[0];
  const target4 = `first fragment GET TTFB ≤ ${limit} ms on a miss`;
  if (!first || first.error || !isNumber(first.ttfbMs)) {
    out.push(verdict('NFR4', target4, 'not measured', first?.error ?? 'no fragment URL in the shell'));
  } else if (!isCached(first.xAtcCache) && first.xAtcCache !== 'MISS') {
    // Without the header the edge cache state is unknown, so the time is neither a known miss nor a hit.
    out.push(
      verdict(
        'NFR4',
        target4,
        'not measured',
        `cache state unknown (X-ATC-Cache ${first.xAtcCache}, TTFB ${ms(first.ttfbMs)}); the response does not report the edge cache`,
      ),
    );
  } else if (first.xAtcCache !== 'MISS') {
    out.push(
      verdict(
        'NFR4',
        target4,
        'not measured',
        `already cached (X-ATC-Cache ${first.xAtcCache}, TTFB ${ms(first.ttfbMs)}); a miss cannot be forced from outside because the cache key ignores unknown parameters`,
      ),
    );
  } else {
    const detail = `TTFB ${ms(first.ttfbMs)} on MISS (single sample)`;
    const misses = [];
    if (!(first.ttfbMs <= limit)) misses.push(`TTFB ${ms(first.ttfbMs)} over ${limit} ms`);
    if (first.status !== 200) misses.push(`status ${first.status}`);
    out.push(
      misses.length
        ? verdict(
            'NFR4',
            target4,
            'fail',
            detail,
            `${misses.join('; ')}; the fragment's data stages run on a miss`,
          )
        : verdict('NFR4', target4, 'pass', detail),
    );
  }

  // NFR5: mobile median savings of both front-end audits.
  const savings = [
    ['Reduce unused JavaScript', m.unusedJs],
    ['Render-blocking requests', m.renderBlocking],
  ];
  if (savings.some(([, v]) => v.used === 0)) {
    out.push(
      verdict('NFR5', 'front-end savings < 150 ms each', 'not measured', 'audit missing from every run'),
    );
  } else {
    const detail = savings.map(([name, v]) => `${name} ${ms(v.value)}`).join(', ');
    const misses = savings.filter(([, v]) => !(v.value < TARGETS.frontEndSavingsMs));
    out.push(
      misses.length
        ? verdict(
            'NFR5',
            'mobile median savings',
            'fail',
            detail,
            `${misses.map(([n]) => n).join(' and ')} save 150 ms or more`,
          )
        : verdict('NFR5', 'mobile median savings', 'pass', detail),
    );
  }
  return out;
}

/** Accepts an https base URL, or http only for this machine; returns the origin-normalised URL. */
export function assertSafeBase(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a URL: ${url}`);
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw new Error(`Refusing ${url}: use https, or http only for localhost or 127.0.0.1`);
  }
  if (parsed.username || parsed.password) throw new Error(`Refusing ${url}: credentials in the URL`);
  return parsed.origin;
}

const decodeAttr = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** The first data-fragment-url in the shell, resolved against the base; null when there is none. */
export function fragmentUrlFromHtml(html, base) {
  const m = /data-fragment-url\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(html ?? '');
  if (!m) return null;
  return new URL(decodeAttr(m[1] ?? m[2]), base).toString();
}

const cell = (v) =>
  String(v ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
const row = (cells) => `| ${cells.map(cell).join(' | ')} |`;
const num = (v, digits = 0) => (isNumber(v) ? v.toFixed(digits) : 'n/a');
const withCount = (m, fmt) => (m.used ? `${fmt(m.value)} (${m.used}/${m.total})` : `n/a (0/${m.total})`);

/** The readable Markdown report. */
export function renderReport(report) {
  const lines = [
    `# Performance report: ${report.startedAt}`,
    '',
    `- Base URL: ${report.baseUrl}`,
    `- Started (UTC): ${report.startedAt}`,
    `- Local \`main\` commit (the live site's deployed commit is not visible from outside): ${report.commit}`,
    `- Lighthouse: ${report.lighthouseVersion}`,
    `- Browser: ${report.browser.path} (${report.browser.version})`,
    `- Runs per preset: ${report.runs}`,
    `- Pages: ${report.pages.map((p) => p.label).join(', ')}${report.partial ? ' (**partial run**, not comparable with a full run)' : ''}`,
    '',
    '## Summary',
    '',
    row([
      'Page',
      'Preset',
      'Median LCP',
      'Median CLS',
      'Median TBT',
      'LCP (median run)',
      'Unused JS',
      'Render-blocking',
    ]),
    row(['---', '---', '---', '---', '---', '---', '---', '---']),
  ];
  for (const page of report.pages) {
    const s = summarizePage(page);
    for (const preset of ['mobile', 'desktop']) {
      const p = s[preset];
      lines.push(
        row([
          page.label,
          preset,
          withCount(p.lcp, ms),
          withCount(p.cls, (v) => num(v, 3)),
          withCount(p.tbt, ms),
          p.lcpRun ? p.lcpRun.lcpClass : 'n/a',
          withCount(p.unusedJs, ms),
          withCount(p.renderBlocking, ms),
        ]),
      );
    }
  }
  lines.push(
    '',
    '## Timed GETs',
    '',
    row(['Page', 'URL', 'Attempt', 'Status', 'TTFB', 'Total', 'Bytes', 'X-ATC-Cache', 'Cache-Control']),
  );
  lines.push(row(['---', '---', '---', '---', '---', '---', '---', '---', '---']));
  for (const page of report.pages) {
    for (const kind of ['page', 'fragment']) {
      for (const t of page.timings?.[kind] ?? []) {
        lines.push(
          row([
            page.label,
            t.url,
            `${kind} ${t.attempt}`,
            t.status,
            ms(t.ttfbMs),
            ms(t.totalMs),
            t.bytes,
            t.xAtcCache,
            t.cacheControl ?? '',
          ]),
        );
        if (t.error) lines.push(row([page.label, t.url, 'error', t.error, '', '', '', '', '']));
      }
    }
    if (!page.fragmentUrl)
      lines.push(row([page.label, '(no data-fragment-url in the shell)', '', '', '', '', '', '', '']));
  }
  lines.push(
    '',
    '## Targets',
    '',
    row(['Page', 'Target', 'Verdict', 'Measured', 'Likely cause']),
    row(['---', '---', '---', '---', '---']),
  );
  for (const page of report.pages) {
    for (const v of judgeTargets(page)) {
      lines.push(row([page.label, v.id, v.status.toUpperCase(), v.detail, v.cause ?? '']));
    }
  }
  lines.push(
    '',
    '## Runs',
    '',
    row(['Page', 'Preset', 'Run', 'LCP', 'CLS', 'TBT', 'LCP element', 'Class', 'Error']),
  );
  lines.push(row(['---', '---', '---', '---', '---', '---', '---', '---', '---']));
  for (const page of report.pages) {
    for (const preset of ['mobile', 'desktop']) {
      for (const r of page.runs?.[preset] ?? []) {
        const el = r.lcpElement ? `\`${r.lcpElement.selector}\` ${r.lcpElement.snippet}` : '';
        lines.push(
          row([
            page.label,
            preset,
            r.run,
            ms(r.lcpMs),
            num(r.cls, 3),
            ms(r.tbtMs),
            el,
            r.lcpClass ?? '',
            r.error ?? r.runtimeError ?? '',
          ]),
        );
      }
    }
  }
  lines.push(
    '',
    '## Limits',
    '',
    '- Lighthouse lab numbers are indicators, not real-user measurements.',
    '- Timed GETs are single samples on a warmed connection; TTFB is the time to the response headers.',
    '- NFR4 is judged only when the first fragment GET is a MISS. A miss cannot be forced from outside, because the cache key ignores unknown parameters.',
    '- CPU time and subrequests per render are not visible from outside the Worker; read them in the Workers dashboard.',
    '',
  );
  return lines.join('\n');
}

const METRICS = [
  ['mobile', 'lcp', 'Mobile LCP', ms],
  ['mobile', 'cls', 'Mobile CLS', (v) => num(v, 3)],
  ['mobile', 'tbt', 'Mobile TBT', ms],
  ['desktop', 'lcp', 'Desktop LCP', ms],
  ['mobile', 'unusedJs', 'Unused JS savings', ms],
  ['mobile', 'renderBlocking', 'Render-blocking savings', ms],
];

/** Before, after and the change per page and metric, then the verdicts after the change. */
export function renderComparison(before, after) {
  const lines = [
    `# Performance comparison`,
    '',
    `- Before: ${before.startedAt} (${before.baseUrl}, commit ${before.commit})`,
    `- After: ${after.startedAt} (${after.baseUrl}, commit ${after.commit})`,
    '',
    row(['Page', 'Metric', 'Before', 'After', 'Change']),
    row(['---', '---', '---', '---', '---']),
  ];
  const beforePages = new Map(before.pages.map((p) => [p.label, p]));
  for (const page of after.pages) {
    const prev = beforePages.get(page.label);
    const a = summarizePage(page);
    const b = prev ? summarizePage(prev) : null;
    for (const [preset, key, name, fmt] of METRICS) {
      const av = a[preset][key].value;
      const bv = b ? b[preset][key].value : null;
      const change = isNumber(av) && isNumber(bv) ? `${av - bv >= 0 ? '+' : ''}${fmt(av - bv)}` : 'n/a';
      lines.push(row([page.label, name, fmt(bv), fmt(av), change]));
    }
    for (const kind of ['page', 'fragment']) {
      const t = (rep, i) => rep?.timings?.[kind]?.[i];
      for (const [i, name] of [
        [0, 'first'],
        [1, 'second'],
      ]) {
        const av = t(page, i)?.ttfbMs;
        const bv = t(prev, i)?.ttfbMs;
        const change = isNumber(av) && isNumber(bv) ? `${av - bv >= 0 ? '+' : ''}${ms(av - bv)}` : 'n/a';
        const label = `${kind} ${name} GET TTFB (${t(prev, i)?.xAtcCache ?? '-'} → ${t(page, i)?.xAtcCache ?? '-'})`;
        lines.push(row([page.label, label, ms(bv), ms(av), change]));
      }
    }
  }
  lines.push(
    '',
    '## Targets after the change',
    '',
    row(['Page', 'Target', 'Verdict', 'Measured', 'Likely cause']),
  );
  lines.push(row(['---', '---', '---', '---', '---']));
  for (const page of after.pages) {
    for (const v of judgeTargets(page))
      lines.push(row([page.label, v.id, v.status.toUpperCase(), v.detail, v.cause ?? '']));
  }
  lines.push('');
  return lines.join('\n');
}
