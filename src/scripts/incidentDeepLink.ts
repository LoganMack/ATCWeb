// The incident report page's deep links from the notifications popup (notifications U3; BR3.3, BR3.4):
// ?open=appeal opens Submit Appeal for the viewer's first appealable incident, and
// ?open=incident&penalty=<id> opens that incident's details. The page's own popup code is private to its
// script, so this only clicks, as a user would; it is imported after that script so its listener runs second.

export type DeepLink = { kind: 'appeal' } | { kind: 'incident'; penaltyId: string };

/** The fields of a row's data-incident-summary this reads. canAppeal is null for a signed-out viewer. */
export interface IncidentSummary {
  penaltyId?: string;
  canAppeal?: boolean | null;
  appealedByMe?: boolean;
}

export type NoticeKind = 'signed-out' | 'nothing' | 'closed';

export const NOTICE_TEXT: Record<NoticeKind, string> = {
  'signed-out': 'Sign in to appeal',
  nothing: 'You have nothing to appeal in this round.',
  closed: 'The appeal window for this round has closed.',
};

export function parseDeepLink(search: string): DeepLink | null {
  const params = new URLSearchParams(search);
  const open = params.get('open');
  if (open === 'appeal') return { kind: 'appeal' };
  const penaltyId = params.get('penalty');
  if (open === 'incident' && penaltyId) return { kind: 'incident', penaltyId };
  return null;
}

/** The address without the deep-link parameters, so a reload or Back does not reopen the popup. */
export function urlWithoutDeepLink(href: string): string {
  const url = new URL(href);
  url.searchParams.delete('open');
  url.searchParams.delete('penalty');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function readSummary(raw: string | undefined): IncidentSummary | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as IncidentSummary) : null;
  } catch {
    return null;
  }
}

/** The Submit Appeal button's own live window check (the page may be cached at the edge). */
export function appealWindowOpen(button: { dataset: DOMStringMap } | null, now: number): boolean {
  if (!button) return false;
  const closesAt = button.dataset.appealClosesAt ? new Date(button.dataset.appealClosesAt).getTime() : NaN;
  return button.dataset.appealOpen === 'true' && Number.isFinite(closesAt) && now < closesAt;
}

export type AppealPick = { action: 'open'; index: number } | { action: 'notice'; notice: NoticeKind };

/** The first row, in list order, the viewer may still appeal; or the notice explaining why there is none. */
export function pickAppealTarget(summaries: (IncidentSummary | null)[], windowOpen: boolean): AppealPick {
  if (summaries.some((s) => s !== null && s.canAppeal === null)) return { action: 'notice', notice: 'signed-out' };
  if (!windowOpen) return { action: 'notice', notice: 'closed' };
  const index = summaries.findIndex((s) => s?.canAppeal === true && s.appealedByMe !== true);
  return index < 0 ? { action: 'notice', notice: 'nothing' } : { action: 'open', index };
}

export function pickIncidentTarget(summaries: (IncidentSummary | null)[], penaltyId: string): number {
  return summaries.findIndex((s) => s?.penaltyId === penaltyId);
}

interface Clickable {
  dataset: DOMStringMap;
  click(): void;
}

/** What the opener needs from the page, injectable for tests. */
export interface DeepLinkPage {
  href: string;
  /** Whether the fragment is in: it always renders the notice element, rows or not. */
  loaded(): boolean;
  /** Every [data-incident-summary] element, in document order. */
  summaries(): Clickable[];
  /** The details popup's [data-open-appeal-dialog] button, or null (a signed-out viewer gets a link). */
  appealButton(): Clickable | null;
  showNotice(kind: NoticeKind): void;
  replaceUrl(url: string): void;
  now(): number;
}

export type DeepLinkOutcome = 'none' | 'waiting' | 'opened' | 'notice' | 'not-found';

/** Acts on the page's deep link once the fragment is in; until then it keeps the parameters. */
export function runDeepLink(page: DeepLinkPage): DeepLinkOutcome {
  const link = parseDeepLink(new URL(page.href).search);
  if (!link) return 'none';
  // Fragment pages fire astro:page-load twice; the first time the fragment is not there yet.
  if (!page.loaded()) return 'waiting';
  page.replaceUrl(urlWithoutDeepLink(page.href));
  const rows = page.summaries();
  // A round with no logged incidents has no rows: there is nothing to open or appeal.
  if (rows.length === 0) {
    if (link.kind === 'incident') return 'not-found';
    page.showNotice('nothing');
    return 'notice';
  }
  const summaries = rows.map((row) => readSummary(row.dataset.incidentSummary));

  if (link.kind === 'incident') {
    const index = pickIncidentTarget(summaries, link.penaltyId);
    if (index < 0) return 'not-found';
    rows[index].click();
    return 'opened';
  }

  const pick = pickAppealTarget(summaries, appealWindowOpen(page.appealButton(), page.now()));
  if (pick.action === 'notice') {
    page.showNotice(pick.notice);
    return 'notice';
  }
  rows[pick.index].click();
  page.appealButton()?.click();
  return 'opened';
}

function showNotice(kind: NoticeKind): void {
  const notice = document.querySelector<HTMLElement>('[data-incident-deeplink-notice]');
  if (!notice) return;
  if (kind === 'signed-out') {
    const link = document.createElement('a');
    link.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    link.className = 'font-semibold underline';
    link.textContent = NOTICE_TEXT[kind];
    notice.replaceChildren(link);
  } else {
    notice.textContent = NOTICE_TEXT[kind];
  }
  notice.hidden = false;
}

function browserPage(): DeepLinkPage {
  return {
    href: location.href,
    loaded: () => document.querySelector('[data-incident-deeplink-notice]') !== null,
    summaries: () => [...document.querySelectorAll<HTMLElement>('[data-incident-summary]')],
    appealButton: () => document.querySelector<HTMLButtonElement>('[data-open-appeal-dialog]'),
    showNotice,
    replaceUrl: (url) => history.replaceState(history.state, '', url),
    now: () => Date.now(),
  };
}

if (typeof document !== 'undefined') {
  document.addEventListener('astro:page-load', () => {
    runDeepLink(browserPage());
  });
}
