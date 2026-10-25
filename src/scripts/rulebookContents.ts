// The rulebook's contents links, imported by src/pages/rulebook.astro only. The browser scrolls to the target;
// this then moves keyboard focus there too (headings carry tabindex="-1", tables tabindex="0"), so the next Tab
// continues from the section the reader jumped to.

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

// A module runs once per page load, so the delegated listener survives the client router swapping <body>.
if (typeof document !== 'undefined') document.addEventListener('click', onClick);
