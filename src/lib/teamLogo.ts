/**
 * Placeholder initials for a team with no logo ("Apex Racing Team" -> "ART"), at most 3 characters to stay
 * readable small (TeamLogo.astro).
 */
export function teamInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = words.map((w) => w[0]!.toUpperCase()).join('');
  return initials.slice(0, 3) || '?';
}
