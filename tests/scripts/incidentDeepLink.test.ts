/**
 * The incident report page's deep links (src/scripts/incidentDeepLink.ts; notifications BR3.3, BR3.4): the
 * appeal link opens Submit Appeal for the first row the viewer may still appeal, skipping one already
 * appealed, or shows why there is none; the incident link opens the matching penalty's details; nothing
 * happens, and the parameters stay, until the fragment's rows are in. The tests have no DOM, so the page is
 * a stand-in that records clicks, notices and the replaced address.
 */
import { describe, expect, it } from 'vitest';
import {
  NOTICE_TEXT,
  appealWindowOpen,
  parseDeepLink,
  pickAppealTarget,
  runDeepLink,
  urlWithoutDeepLink,
  type DeepLinkPage,
  type IncidentSummary,
  type NoticeKind,
} from '../../src/scripts/incidentDeepLink';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const OPEN_UNTIL = '2026-11-10T12:00:00Z';
const BASE = 'https://atc.example.test/results/81234567/incidents';

interface FakeElement {
  name: string;
  dataset: DOMStringMap;
  click(): void;
}

function fakePage(
  href: string,
  summaries: IncidentSummary[],
  appealWindow: { open: boolean; closesAt?: string } | null,
  loaded = true,
) {
  const log: string[] = [];
  const notices: NoticeKind[] = [];
  let replaced: string | null = null;
  const rows: FakeElement[] = summaries.map((s, i) => ({
    name: `row${i}`,
    dataset: { incidentSummary: JSON.stringify(s) },
    click: () => log.push(`row${i}`),
  }));
  const button: FakeElement | null = appealWindow
    ? {
        name: 'appeal',
        dataset: { appealOpen: String(appealWindow.open), appealClosesAt: appealWindow.closesAt ?? OPEN_UNTIL },
        click: () => log.push('appeal'),
      }
    : null;
  const page: DeepLinkPage = {
    href,
    loaded: () => loaded,
    summaries: () => rows,
    appealButton: () => button,
    showNotice: (kind) => notices.push(kind),
    replaceUrl: (url) => {
      replaced = url;
    },
    now: () => NOW,
  };
  return { page, log, notices, replaced: () => replaced };
}

const mine = (penaltyId: string, extra: Partial<IncidentSummary> = {}): IncidentSummary => ({
  penaltyId,
  canAppeal: true,
  appealedByMe: false,
  ...extra,
});
const others = (penaltyId: string): IncidentSummary => ({ penaltyId, canAppeal: false, appealedByMe: false });

describe('?open=appeal (BR3.3)', () => {
  it('opens Submit Appeal for the first appealable row in list order', () => {
    const { page, log, replaced } = fakePage(`${BASE}?open=appeal`, [others('p1'), mine('p2'), mine('p3')], {
      open: true,
    });
    expect(runDeepLink(page)).toBe('opened');
    expect(log).toEqual(['row1', 'appeal']);
    expect(replaced()).toBe('/results/81234567/incidents');
  });

  it('skips a row the viewer has already appealed', () => {
    const { page, log } = fakePage(`${BASE}?open=appeal`, [mine('p1', { appealedByMe: true }), mine('p2')], {
      open: true,
    });
    runDeepLink(page);
    expect(log).toEqual(['row1', 'appeal']);
  });

  it('says there is nothing to appeal when no row qualifies', () => {
    const { page, log, notices } = fakePage(
      `${BASE}?open=appeal`,
      [others('p1'), mine('p2', { appealedByMe: true })],
      { open: true },
    );
    expect(runDeepLink(page)).toBe('notice');
    expect(notices).toEqual(['nothing']);
    expect(log).toEqual([]);
    expect(NOTICE_TEXT.nothing).toBe('You have nothing to appeal in this round.');
  });

  it('says the window has closed, also when the live check finds it passed', () => {
    const closed = fakePage(`${BASE}?open=appeal`, [mine('p1')], { open: false });
    runDeepLink(closed.page);
    expect(closed.notices).toEqual(['closed']);
    const passed = fakePage(`${BASE}?open=appeal`, [mine('p1')], { open: true, closesAt: '2026-11-09T11:00:00Z' });
    runDeepLink(passed.page);
    expect(passed.notices).toEqual(['closed']);
    expect(NOTICE_TEXT.closed).toBe('The appeal window for this round has closed.');
  });

  it('asks a signed-out viewer to sign in and opens nothing', () => {
    const { page, log, notices } = fakePage(`${BASE}?open=appeal`, [{ penaltyId: 'p1', canAppeal: null }], null);
    expect(runDeepLink(page)).toBe('notice');
    expect(notices).toEqual(['signed-out']);
    expect(log).toEqual([]);
  });
});

describe('?open=incident&penalty= (BR3.4)', () => {
  it('opens the details of the first row with that penalty', () => {
    const { page, log, replaced } = fakePage(
      `${BASE}?from=reports&open=incident&penalty=p2#top`,
      [others('p1'), others('p2'), others('p2')],
      { open: true },
    );
    expect(runDeepLink(page)).toBe('opened');
    expect(log).toEqual(['row1']);
    expect(replaced()).toBe('/results/81234567/incidents?from=reports#top');
  });

  it('does nothing when no row matches, but still drops the parameters', () => {
    const { page, log, replaced } = fakePage(`${BASE}?open=incident&penalty=gone`, [others('p1')], { open: true });
    expect(runDeepLink(page)).toBe('not-found');
    expect(log).toEqual([]);
    expect(replaced()).toBe('/results/81234567/incidents');
  });
});

describe('timing and parsing', () => {
  it('waits, keeping the parameters, until the fragment is in', () => {
    const { page, log, notices, replaced } = fakePage(`${BASE}?open=appeal`, [], { open: true }, false);
    expect(runDeepLink(page)).toBe('waiting');
    expect(log).toEqual([]);
    expect(notices).toEqual([]);
    expect(replaced()).toBeNull();
  });

  it('says there is nothing to appeal on a loaded round with no incidents, and drops the parameters', () => {
    const appeal = fakePage(`${BASE}?open=appeal`, [], { open: true });
    expect(runDeepLink(appeal.page)).toBe('notice');
    expect(appeal.notices).toEqual(['nothing']);
    expect(appeal.log).toEqual([]);
    expect(appeal.replaced()).toBe('/results/81234567/incidents');
    const incident = fakePage(`${BASE}?open=incident&penalty=p1`, [], { open: true });
    expect(runDeepLink(incident.page)).toBe('not-found');
    expect(incident.replaced()).toBe('/results/81234567/incidents');
  });

  it('ignores a page with no deep link', () => {
    const { page, replaced } = fakePage(`${BASE}?from=reports`, [mine('p1')], { open: true });
    expect(runDeepLink(page)).toBe('none');
    expect(replaced()).toBeNull();
  });

  it('parses only the two link shapes', () => {
    expect(parseDeepLink('?open=appeal')).toEqual({ kind: 'appeal' });
    expect(parseDeepLink('?open=incident&penalty=p9')).toEqual({ kind: 'incident', penaltyId: 'p9' });
    expect(parseDeepLink('?open=incident')).toBeNull();
    expect(parseDeepLink('?open=other')).toBeNull();
    expect(urlWithoutDeepLink(`${BASE}?open=appeal&season=ATC18`)).toBe('/results/81234567/incidents?season=ATC18');
  });

  it('reads the window from the Submit Appeal button as the page does', () => {
    expect(appealWindowOpen(null, NOW)).toBe(false);
    expect(appealWindowOpen({ dataset: { appealOpen: 'true', appealClosesAt: OPEN_UNTIL } }, NOW)).toBe(true);
    expect(appealWindowOpen({ dataset: { appealOpen: 'true', appealClosesAt: '' } }, NOW)).toBe(false);
    expect(pickAppealTarget([null, mine('p1')], true)).toEqual({ action: 'open', index: 1 });
  });
});
