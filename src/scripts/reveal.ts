/**
 * Adds `.is-visible` to any `.reveal` element as it scrolls into view.
 * Re-runs after each Astro view transition since swapped-in pages need
 * their own observer.
 */
function initReveal() {
  const els = document.querySelectorAll<HTMLElement>('.reveal:not(.is-visible)');
  if (!els.length) return;

  // A small bottom rootMargin finishes the reveal just before an element reaches the screen, so long lists
  // don't appear to animate in row by row on a fast scroll.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.01, rootMargin: '0px 0px 15% 0px' },
  );

  els.forEach((el) => observer.observe(el));
}

document.addEventListener('astro:page-load', initReveal);
