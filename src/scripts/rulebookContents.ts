// The rulebook's contents links, imported by src/pages/rulebook.astro only. The browser scrolls to the target;
// this then moves keyboard focus there too (headings carry tabindex="-1", tables tabindex="0"), so the next Tab
// continues from the section the reader jumped to. While the reader scrolls, the current section's links (in
// both copies of the panel) show a blue dot and carry aria-current="location" (FR1).

/** Just below the sticky header: a heading whose top has passed this line has been reached. */
export const READING_LINE_PX = 120;

/**
 * The index of the current section: the last heading whose top has passed the reading line, the first before
 * any has, and the last at the very bottom of the page. -1 when there are no headings.
 */
export function currentSectionIndex(tops: number[], readingLine: number, atBottom: boolean): number {
  if (tops.length === 0) return -1;
  if (atBottom) return tops.length - 1;
  let current = 0;
  for (let i = 0; i < tops.length; i++) if (tops[i] <= readingLine) current = i;
  return current;
}

/** The id of the current section among `ids` (same order as `tops`), or null when there are none. */
export function currentSectionId(
  ids: string[],
  tops: number[],
  readingLine: number,
  atBottom: boolean,
): string | null {
  const index = currentSectionIndex(tops, readingLine, atBottom);
  return index >= 0 ? (ids[index] ?? null) : null;
}

function onClick(event: MouseEvent): void {
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest<HTMLAnchorElement>('a[data-rulebook-jump]');
  if (!link || !link.hash) return;
  let id: string;
  try {
    id = decodeURIComponent(link.hash.slice(1));
  } catch {
    return;
  }
  const target = document.getElementById(id);
  if (target) requestAnimationFrame(() => target.focus({ preventScroll: true }));
}

// --- Current-section marker ----------------------------------------------------------------------

let lastId: string | null | undefined;
let frame = 0;

function markCurrent(): void {
  frame = 0;
  const links = [...document.querySelectorAll<HTMLAnchorElement>('a[data-rulebook-target]')];
  if (links.length === 0) return;
  // Both panel copies list the same headings; measure each target once, in document order.
  const ids = [...new Set(links.map((a) => a.dataset.rulebookTarget ?? ''))].filter(Boolean);
  const targets = ids.map((id) => document.getElementById(id));
  const present = ids.filter((_, i) => targets[i]);
  const tops = targets.filter((t): t is HTMLElement => t !== null).map((t) => t.getBoundingClientRect().top);
  const root = document.documentElement;
  const atBottom = window.innerHeight + window.scrollY >= root.scrollHeight - 2;
  const id = currentSectionId(present, tops, READING_LINE_PX, atBottom);
  if (id === lastId) return;
  lastId = id;
  for (const link of links) {
    const current = link.dataset.rulebookTarget === id;
    if (current) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
    link.querySelector('[data-rulebook-dot]')?.classList.toggle('hidden', !current);
  }
}

function scheduleMark(): void {
  if (frame === 0) frame = requestAnimationFrame(markCurrent);
}

function initPage(): void {
  lastId = undefined;
  if (document.querySelector('a[data-rulebook-target]')) scheduleMark();
}

// A module runs once per page load, so the delegated listeners survive the client router swapping <body>.
if (typeof document !== 'undefined') {
  document.addEventListener('click', onClick);
  window.addEventListener('scroll', scheduleMark, { passive: true });
  window.addEventListener('resize', scheduleMark, { passive: true });
  document.addEventListener('astro:page-load', initPage);
}
