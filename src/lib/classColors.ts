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

/** Just the text-color portion of classBadgeClasses (no border) — for an element like a trophy icon that only needs the class's color via `currentColor`, not the badge's border/background treatment. */
export function classTextColorClass(className: string): string {
  return CLASS_BADGE_COLOR[className]?.split(' ')[0] ?? 'text-white/70';
}

/**
 * Single-letter shorthand for a class badge ("Alpha" -> "A") — for tight
 * inline spaces where the full class name competes with a name/flag/car
 * number on one line (see the per-driver badges in team-stats/fragment.astro's
 * expanded roster). Colors still come from classBadgeClasses; this only
 * shortens the label.
 */
export function classBadgeLetter(className: string): string {
  return className.charAt(0).toUpperCase();
}
