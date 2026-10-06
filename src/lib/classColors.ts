/**
 * Alpha = blue, Gamma = pink, Delta = gold — matches the site-wide
 * primary/secondary/tertiary color hierarchy (see tailwind.config.mjs).
 * Originally lived only in DriverRow.astro for the Roster's class badge;
 * pulled out here so the race-results pages can color-code their new CLASS
 * column the same way instead of re-implementing the mapping.
 */
export const CLASS_BADGE_COLOR: Record<string, string> = {
  Alpha: 'text-brand-blue',
  Gamma: 'text-brand-pink',
  Delta: 'text-brand-gold',
};

export function classBadgeClasses(className: string): string {
  return CLASS_BADGE_COLOR[className] ?? 'text-white/70';
}

/** Just the text-color portion of classBadgeClasses — for an element like a trophy icon that only needs the class's color via `currentColor`. */
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

/**
 * Shared shape for every class tag on the site (plain bold text — no border or fill, per Logan), so they can never drift
 * apart again: always bold + uppercase, and a FIXED width per variant —
 * every full-name pill ("ALPHA"/"GAMMA"/"DELTA") is the same width as every
 * other full-name pill, and every one-letter pill ("A"/"G"/"D") is the same
 * width as every other one-letter pill. Text is centered in that fixed width.
 * Full literal class strings (Tailwind's JIT only sees names verbatim in
 * source).
 */
const CLASS_TAG_BASE = 'inline-flex flex-none items-center justify-start py-0.5 font-bold uppercase tracking-wide';

/** Full-name class pill ("ALPHA") — pair with the class's own name as the text. */
export function classTagFull(className: string): string {
  return `${CLASS_TAG_BASE} w-16 text-[11px] ${classBadgeClasses(className)}`;
}

/** One-letter class pill ("A") — pair with classBadgeLetter(className) as the text. */
export function classTagShort(className: string): string {
  return `${CLASS_TAG_BASE} w-6 text-[10px] ${classBadgeClasses(className)}`;
}
