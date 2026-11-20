/**
 * The Advanced Stats page's View select (FR1.1-FR1.5): the four views, how an address value resolves to one,
 * and each view's address. Unknown values fall back (Compare, Overall, the current season) so the address,
 * the filter card and the edge-cache key always agree.
 */
import type { Championship } from './calculator/types';
import { RATING_KIND_PARAMS, type RatingKind } from './db/seriesRatings';

export const ADVANCED_VIEWS = ['compare', 'contenders', 'scenarios', 'irating'] as const;
export type AdvancedView = (typeof ADVANCED_VIEWS)[number];

export const ADVANCED_VIEW_LABELS: Record<AdvancedView, string> = {
  compare: 'Compare',
  contenders: 'Points Contenders',
  scenarios: 'Points Scenarios',
  irating: 'Series iRating',
};

/** The two views the points calculator draws; switching between them keeps the reader's edits. */
export type CalculatorView = 'contenders' | 'scenarios';

export function isCalculatorView(view: AdvancedView): view is CalculatorView {
  return view === 'contenders' || view === 'scenarios';
}

/** Exact match, else Compare (FR1.5). */
export function resolveAdvancedView(value: string | null | undefined): AdvancedView {
  return (ADVANCED_VIEWS as readonly string[]).includes(value ?? '') ? (value as AdvancedView) : 'compare';
}

/** A calculator view's query: Overall adds no championship value, so it shares the bare edge-cache key. */
export function calculatorQuery(view: CalculatorView, seasonNumber: number | null, championship: Championship): string {
  const params = new URLSearchParams({ view });
  if (seasonNumber !== null) params.set('season', String(seasonNumber));
  if (championship !== 'overall') params.set('championship', championship);
  return `?${params.toString()}`;
}

/** The calculator fragment's query: the season and championship only (the view is drawn in the browser). */
export function calculatorFragmentQuery(seasonNumber: number | null, championship: Championship): string {
  const params = new URLSearchParams();
  if (seasonNumber !== null) params.set('season', String(seasonNumber));
  if (championship !== 'overall') params.set('championship', championship);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** The Series iRating query for one kind; Overall carries no class value. */
export function ratingQuery(kind: RatingKind, withView = true): string {
  const params = new URLSearchParams();
  if (withView) params.set('view', 'irating');
  const value = RATING_KIND_PARAMS[kind];
  if (value !== null) params.set('class', value);
  const query = params.toString();
  return query ? `?${query}` : '';
}
