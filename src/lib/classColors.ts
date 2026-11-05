/**
 * Alpha = blue, Gamma = pink, Delta = gold, following the primary/secondary/tertiary brand order
 * (tailwind.config.mjs). Shared so every class badge colours the same way.
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
 * "Alpha" -> "A", for tight inline spots such as the team-stats roster badges; colours still come from
 * classBadgeClasses.
 */
export function classBadgeLetter(className: string): string {
  return className.charAt(0).toUpperCase();
}

/** A class's badge image: 64 px and 128 px WebP (1x and 2x), with the class name as its text alternative. */
export interface ClassBadgeImage {
  src: string;
  srcset: string;
  alt: string;
}

// The league's three class badges (public/images/classes/); any other class keeps its letter.
const CLASS_IMAGE_SLUGS: Record<string, string> = { alpha: 'alpha', gamma: 'gamma', delta: 'delta' };

/** The badge image for Alpha, Gamma or Delta (any letter case), else null. */
export function classBadgeImage(className: string | null | undefined): ClassBadgeImage | null {
  const name = (className ?? '').trim();
  const key = name.toLowerCase();
  if (!Object.hasOwn(CLASS_IMAGE_SLUGS, key)) return null;
  const base = `/images/classes/${CLASS_IMAGE_SLUGS[key]}`;
  return { src: `${base}-64.webp`, srcset: `${base}-64.webp 1x, ${base}-128.webp 2x`, alt: name };
}

/**
 * Shared shape for every class tag (plain bold uppercase text, per Logan) with one fixed width per variant,
 * so full-name and one-letter tags each line up. Full literal class strings, since Tailwind only sees names
 * verbatim.
 */
const CLASS_TAG_BASE =
  'inline-flex flex-none items-center justify-start py-0.5 font-bold uppercase tracking-wide';

/** Full-name class pill ("ALPHA") — pair with the class's own name as the text. */
export function classTagFull(className: string): string {
  return `${CLASS_TAG_BASE} w-16 text-[11px] ${classBadgeClasses(className)}`;
}

/** One-letter class pill ("A") — pair with classBadgeLetter(className) as the text. */
export function classTagShort(className: string): string {
  return `${CLASS_TAG_BASE} w-6 text-[10px] ${classBadgeClasses(className)}`;
}
