/**
 * Alpha = blue, Gamma = pink, Delta = gold — matches the site-wide
 * primary/secondary/tertiary color hierarchy (see tailwind.config.mjs).
 * Originally lived only in DriverRow.astro for the Roster's class badge;
 * pulled out here so the race-results pages can color-code their new CLASS
 * column the same way instead of re-implementing the mapping.
 */
export const CLASS_BADGE_COLOR: Record<string, string> = {
  Alpha: 'text-brand-blue border-brand-blue/40',
  Gamma: 'text-brand-pink border-brand-pink/40',
  Delta: 'text-brand-gold border-brand-gold/40',
};

export function classBadgeClasses(className: string): string {
  return CLASS_BADGE_COLOR[className] ?? 'text-white/70 border-white/20';
}
