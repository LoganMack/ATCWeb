/**
 * Series iRating table (FR7.2, FR8.3; NFR6): sortable headers with aria-sort and a name search over the rows
 * the advanced-stats/ratings fragment rendered. Everything runs in the browser over those rows; a hidden
 * driver's row is already named "Hidden Driver", so the search can only ever match that name. The sort and
 * search rules are plain functions so the tests run them without a DOM.
 */

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
export function sortEntries<T extends RatingEntry>(entries: readonly T[], key: RatingSortKey, direction: SortDirection): T[] {
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

function entryOf(row: HTMLElement): RatingEntry & { row: HTMLElement } {
  const n = (name: string) => Number(row.dataset[name] ?? 0);
  return {
    row,
    rank: n('rank'),
    name: row.dataset.name ?? '',
    current: n('current'),
    last: n('last'),
    min: n('min'),
    max: n('max'),
    races: n('races'),
  };
}

function bindTable(section: HTMLElement): void {
  if (section.dataset.ratingsBound) return;
  const table = section.querySelector<HTMLTableElement>('[data-rating-table]');
  const tbody = table?.tBodies[0];
  if (!table || !tbody) return;
  section.dataset.ratingsBound = 'true';
  const entries = [...tbody.querySelectorAll<HTMLElement>('[data-rating-row]')].map(entryOf);
  const search = section.querySelector<HTMLInputElement>('[data-rating-search]');
  const count = section.querySelector<HTMLElement>('[data-rating-count]');
  const noMatch = section.querySelector<HTMLElement>('[data-rating-no-match]');
  const noMatchText = section.querySelector<HTMLElement>('[data-rating-no-match-text]');
  const wrap = section.querySelector<HTMLElement>('[data-rating-table-wrap]');
  let sort: { key: RatingSortKey; direction: SortDirection } = { key: 'current', direction: 'descending' };

  const applySort = () => {
    tbody.append(...sortEntries(entries, sort.key, sort.direction).map((e) => e.row));
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
      if (match) shown++;
    }
    const none = shown === 0;
    if (noMatch) noMatch.classList.toggle('hidden', !none);
    if (noMatchText) noMatchText.textContent = none ? `No driver matches “${query.trim()}”.` : '';
    if (wrap) wrap.hidden = none;
    if (count) count.textContent = resultCountText(shown, entries.length);
  };

  table.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>('button[data-sort]');
    const key = button?.dataset.sort;
    if (!isRatingSortKey(key)) return;
    sort = nextSort(sort, key);
    applySort();
  });
  search?.addEventListener('input', applySearch);
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
