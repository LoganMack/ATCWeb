/**
 * Builds a short placeholder acronym from a team name when no logo has been
 * uploaded — one letter per word (e.g. "Apex Racing Team" -> "ART"), capped
 * at 3 characters so it stays readable at the small sizes this renders at
 * (roster rows, results tables). See `src/components/TeamLogo.astro`.
 */
export function teamInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = words.map((w) => w[0]!.toUpperCase()).join('');
  return initials.slice(0, 3) || '?';
}
