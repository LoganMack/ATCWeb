/**
 * The desktop nav's side menus (nav-side-menus BR1.1-BR1.4, BR1.10): Standings > Drivers and Teams, and one
 * link per Advanced Stats view. Server only: it reads the view registry, whose module pulls in a database
 * module, so only the Nav.astro frontmatter may import it, never a browser script.
 */
import { ADVANCED_VIEW_LABELS, ADVANCED_VIEWS } from './advancedStatsViews';

export type NavSideItem = { readonly href: string; readonly label: string };

function frozenMenu(items: NavSideItem[]): readonly NavSideItem[] {
  return Object.freeze(items.map((item) => Object.freeze({ ...item })));
}

export const DRIVERS_SIDE_MENU = frozenMenu([
  { href: '/standings?championship=drivers', label: 'Overall' },
  { href: '/standings?championship=drivers&class=Gamma', label: 'Gamma' },
  { href: '/standings?championship=drivers&class=Delta', label: 'Delta' },
]);

export const TEAMS_SIDE_MENU = frozenMenu([
  { href: '/standings?championship=teams', label: 'Overall' },
  { href: '/standings?championship=teams&class=Delta', label: 'Delta' },
]);

// Read from the registry, so a view added there shows up here with no nav change (C3).
export const ADVANCED_SIDE_MENU = frozenMenu(
  ADVANCED_VIEWS.map((view) => ({ href: '/advanced-stats?view=' + view, label: ADVANCED_VIEW_LABELS[view] })),
);

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** The side panel's id, for example `nav-side-standings-drivers`; Nav renders once per page, so it is unique. */
export function sideMenuId(section: string, item: string): string {
  return `nav-side-${slug(section)}-${slug(item)}`;
}

/** The toggle's accessible name, for example "Show Drivers standings views". */
export function sideMenuToggleLabel(section: string, item: string): string {
  return `Show ${item} ${section.toLowerCase()} views`;
}
