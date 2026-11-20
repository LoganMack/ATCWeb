/**
 * Series iRating table (FR7.2, FR8.3; NFR6): sortable headers with aria-sort, the name search in the shell's
 * filter card, and each row's history chart, opened by the row's toggle button. Everything runs in the browser
 * over the rows the advanced-stats/ratings fragment rendered; a row's history is fetched once, the first time
 * it opens (advanced-stats/ratings/history), so the list never carries it. A hidden driver's row is already
 * named "Hidden Driver" and keyed by a stand-in, so the search and the history can only ever use those. The
 * sort, search and request rules are plain functions so the tests run them without a DOM.
 */
import type { RatingHistoryPoint } from '../lib/db/seriesRatings';
import { renderHistoryChart } from './ratingHistoryChart';

export type RatingSortKey = 'rank' | 'name' | 'current' | 'last' | 'min' | 'max' | 'races';
export type SortDirection = 'ascending' | 'descending';

export interface RatingEntry {
  rank: number;
  name: string;
  current: number;
  last: number;
  min: number;
  max: number;
  races: number;
}

const RATING_SORT_KEYS: readonly RatingSortKey[] = ['rank', 'name', 'current', 'last', 'min', 'max', 'races'];

export function isRatingSortKey(value: string | undefined): value is RatingSortKey {
  return (RATING_SORT_KEYS as readonly string[]).includes(value ?? '');
}

/** The direction a header click gives: the same column flips; a new column starts high-first (names A-Z). */
export function nextSort(
  current: { key: RatingSortKey; direction: SortDirection },
  clicked: RatingSortKey,
): { key: RatingSortKey; direction: SortDirection } {
  if (current.key === clicked) {
    return { key: clicked, direction: current.direction === 'ascending' ? 'descending' : 'ascending' };
  }
  return { key: clicked, direction: clicked === 'name' || clicked === 'rank' ? 'ascending' : 'descending' };
}

/** Sorted copy; ties keep the default order (rank), so the list never jumps about. */
export function sortEntries<T extends RatingEntry>(
  entries: readonly T[],
  key: RatingSortKey,
  direction: SortDirection,
): T[] {
  const sign = direction === 'ascending' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const diff = key === 'name' ? a.name.localeCompare(b.name) : a[key] - b[key];
    return sign * diff || a.rank - b.rank;
  });
}

/** Case-insensitive substring match on the shown name; an empty search matches everyone. */
export function matchesSearch(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === '' || name.toLowerCase().includes(q);
}

export function resultCountText(shown: number, total: number): string {
  if (shown === total) return `${total} ${total === 1 ? 'driver' : 'drivers'}`;
  return `${shown} of ${total} drivers match`;
}

/** The history route for one row: the list's class value (none for Overall) and the row's key. */
export function historyUrl(ratingClass: string, driverKey: string): string {
  const params = new URLSearchParams();
  if (ratingClass) params.set('class', ratingClass);
  params.set('driver', driverKey);
  return `/advanced-stats/ratings/history?${params.toString()}`;
}

/** The steps from the route's JSON, or null when it is not the expected shape. */
export function parseHistory(body: unknown): RatingHistoryPoint[] | null {
  const steps = (body as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return null;
  return steps.filter(
    (s): s is RatingHistoryPoint =>
      typeof s === 'object' &&
      s !== null &&
      typeof s.v === 'number' &&
      typeof s.p === 'number' &&
      typeof s.d === 'string',
  );
}

interface Entry extends RatingEntry {
  row: HTMLElement;
  detail: HTMLElement | null;
  toggle: HTMLButtonElement | null;
  key: string;
  loaded: boolean;
}

function entryOf(row: HTMLElement): Entry {
  const n = (name: string) => Number(row.dataset[name] ?? 0);
  const detail = row.nextElementSibling as HTMLElement | null;
  return {
    row,
    detail: detail?.hasAttribute('data-rating-detail') ? detail : null,
    toggle: row.querySelector<HTMLButtonElement>('[data-rating-toggle]'),
    key: row.dataset.key ?? '',
    loaded: false,
    rank: n('rank'),
    name: row.dataset.name ?? '',
    current: n('current'),
    last: n('last'),
    min: n('min'),
    max: n('max'),
    races: n('races'),
  };
}

function setOpen(e: Entry, open: boolean): void {
  if (!e.detail || !e.toggle) return;
  e.toggle.setAttribute('aria-expanded', String(open));
  e.toggle.querySelector('[data-chevron]')?.classList.toggle('rotate-90', open);
  e.detail.hidden = !open;
}

async function loadHistory(section: HTMLElement, e: Entry): Promise<void> {
  const chart = e.detail?.querySelector<HTMLElement>('[data-rating-chart]');
  if (!chart) return;
  e.loaded = true;
  const kindLabel = section.dataset.ratingKindLabel ?? 'Overall';
  chart.replaceChildren(
    Object.assign(document.createElement('p'), {
      className: 'text-sm text-white/60',
      textContent: 'Loading the rating history…',
    }),
  );
  chart.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(historyUrl(section.dataset.ratingClass ?? '', e.key), {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const steps = parseHistory(await response.json());
    if (!steps) throw new Error('Unexpected rating history');
    renderHistoryChart(chart, steps, { name: e.name, kindLabel });
  } catch (err) {
    console.error('Failed to load a Series iRating history:', err);
    e.loaded = false;
    const retry = Object.assign(document.createElement('button'), {
      type: 'button',
      className: 'btn btn-sm ml-2',
      textContent: 'Try again',
    });
    retry.addEventListener('click', () => void loadHistory(section, e));
    const message = Object.assign(document.createElement('p'), {
      className: 'text-sm text-white/60',
      textContent: 'Couldn’t load the rating history.',
    });
    message.append(retry);
    chart.replaceChildren(message);
  } finally {
    chart.removeAttribute('aria-busy');
  }
}

function bindTable(section: HTMLElement): void {
  if (section.dataset.ratingsBound) return;
  const table = section.querySelector<HTMLTableElement>('[data-rating-table]');
  const tbody = table?.tBodies[0];
  if (!table || !tbody) return;
  section.dataset.ratingsBound = 'true';
  const entries = [...tbody.querySelectorAll<HTMLElement>('[data-rating-row]')].map(entryOf);
  const byToggle = new Map(entries.flatMap((e) => (e.toggle ? [[e.toggle, e] as const] : [])));
  // The search box lives in the shell's filter card, outside the fragment.
  const search = document.querySelector<HTMLInputElement>('[data-rating-search]');
  const count = section.querySelector<HTMLElement>('[data-rating-count]');
  const noMatch = section.querySelector<HTMLElement>('[data-rating-no-match]');
  const noMatchText = section.querySelector<HTMLElement>('[data-rating-no-match-text]');
  const wrap = section.querySelector<HTMLElement>('[data-rating-table-wrap]');
  let sort: { key: RatingSortKey; direction: SortDirection } = { key: 'current', direction: 'descending' };

  const applySort = () => {
    // Each row keeps its history row right after it.
    tbody.append(
      ...sortEntries(entries, sort.key, sort.direction).flatMap((e) =>
        e.detail ? [e.row, e.detail] : [e.row],
      ),
    );
    table.querySelectorAll<HTMLElement>('th[data-sort-col]').forEach((th) => {
      th.setAttribute('aria-sort', th.dataset.sortCol === sort.key ? sort.direction : 'none');
    });
  };

  const applySearch = () => {
    const query = search?.value ?? '';
    let shown = 0;
    for (const e of entries) {
      const match = matchesSearch(e.name, query);
      e.row.hidden = !match;
      if (!match) setOpen(e, false);
      if (match) shown++;
    }
    const none = shown === 0;
    if (noMatch) noMatch.classList.toggle('hidden', !none);
    if (noMatchText) noMatchText.textContent = none ? `No driver matches “${query.trim()}”.` : '';
    if (wrap) wrap.hidden = none;
    if (count) count.textContent = resultCountText(shown, entries.length);
  };

  table.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const toggle = target.closest<HTMLButtonElement>('button[data-rating-toggle]');
    const e = toggle ? byToggle.get(toggle) : undefined;
    if (e) {
      const open = toggle!.getAttribute('aria-expanded') !== 'true';
      setOpen(e, open);
      if (open && !e.loaded) void loadHistory(section, e);
      return;
    }
    const key = target.closest<HTMLElement>('button[data-sort]')?.dataset.sort;
    if (!isRatingSortKey(key)) return;
    sort = nextSort(sort, key);
    applySort();
  });
  // Bound per fragment load; a replaced fragment's handler does nothing.
  search?.addEventListener('input', () => {
    if (section.isConnected) applySearch();
  });
  if (search?.value) applySearch();
  section.querySelector('[data-rating-clear]')?.addEventListener('click', () => {
    if (search) search.value = '';
    applySearch();
    search?.focus();
  });
}

function initSeriesRatings(): void {
  document.querySelectorAll<HTMLElement>('[data-ratings-view] [data-series-ratings]').forEach(bindTable);
}

if (typeof document !== 'undefined') {
  initSeriesRatings();
  document.addEventListener('astro:page-load', initSeriesRatings);
}
