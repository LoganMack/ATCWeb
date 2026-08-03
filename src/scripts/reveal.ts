/**
 * Adds `.is-visible` to any `.reveal` element as it scrolls into view.
 * Re-runs after each Astro view transition since swapped-in pages need
 * their own observer.
 */
function initReveal() {
  const els = document.querySelectorAll<HTMLElement>('.reveal:not(.is-visible)');
  if (!els.length) return;

  // A small positive bottom rootMargin means an element counts as "in view"
  // slightly before it actually reaches the bottom of the screen, so by the
  // time someone scrolls to it the reveal has already finished — instead of
  // visibly popping in mid-scroll. Combined with the shorter, smaller
  // transition in global.css, this keeps big lists (roster, calendar,
  // teams) from looking like they're animating in one row at a time while
  // the page whizzes by during a fast scroll.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.01, rootMargin: '0px 0px 15% 0px' }
  );

  els.forEach((el) => observer.observe(el));
}

document.addEventListener('astro:page-load', initReveal);
