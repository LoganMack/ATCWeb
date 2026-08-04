/**
 * Click-to-enlarge for any `[data-lightbox]` trigger (see ChampionCard.astro
 * and the admin champion-photo upload page) — opens a full-size overlay on
 * click, closes on backdrop click, the close button, or Escape.
 *
 * Uses a single delegated listener on <body>, guarded by a dataset flag
 * (the same pattern hard-form-submit.ts uses per-form), instead of binding
 * a listener to every photo — new photos swapped in by a view transition
 * are covered automatically without needing to re-bind on astro:page-load.
 */

function ensureOverlay(): HTMLDivElement {
  const existing = document.getElementById('lightbox-overlay') as HTMLDivElement | null;
  if (existing) return existing;

  const overlay = document.createElement('div');
  overlay.id = 'lightbox-overlay';
  overlay.className = 'fixed inset-0 z-50 hidden items-center justify-center bg-black/90 p-6 backdrop-blur-sm';
  overlay.innerHTML = `
    <button type="button" data-lightbox-close aria-label="Close" class="absolute right-5 top-5 text-4xl leading-none text-white/70 transition hover:text-white">&times;</button>
    <img class="max-h-full max-w-full rounded-md object-contain" alt="" />
  `;
  document.body.appendChild(overlay);

  function close() {
    overlay.classList.add('hidden');
    overlay.classList.remove('flex');
    document.body.classList.remove('overflow-hidden');
  }

  overlay.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target === overlay || target.closest('[data-lightbox-close]')) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  return overlay;
}

function openLightbox(src: string, alt: string) {
  const overlay = ensureOverlay();
  const img = overlay.querySelector('img')!;
  img.src = src;
  img.alt = alt;
  overlay.classList.remove('hidden');
  overlay.classList.add('flex');
  document.body.classList.add('overflow-hidden');
}

function initLightbox() {
  if (document.body.dataset.lightboxBound === 'true') return;
  document.body.dataset.lightboxBound = 'true';

  document.body.addEventListener('click', (e) => {
    const trigger = (e.target as HTMLElement).closest<HTMLElement>('[data-lightbox]');
    if (!trigger) return;
    const src = trigger.dataset.lightboxSrc;
    if (!src) return;
    openLightbox(src, trigger.dataset.lightboxAlt || '');
  });
}

document.addEventListener('astro:page-load', initLightbox);
