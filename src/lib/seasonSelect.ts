/**
 * Attributes that give a season <option> its logo in the custom dropdown (src/scripts/logoSelect.ts):
 * `<option value={s.id} {...seasonOptionAttrs(s)}>`. The <select> needs `data-logo-select`; options without
 * them render as text.
 */
export function seasonOptionAttrs(
  season: { logo_url?: string | null; logo_url_light?: string | null } | null | undefined,
): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (season?.logo_url) attrs['data-logo'] = season.logo_url;
  if (season?.logo_url && season.logo_url_light) attrs['data-logo-light'] = season.logo_url_light;
  return attrs;
}

/** Same, for callers that hold a SeasonLogoPair ({ dark, light }) instead of a Season row. */
export function logoPairOptionAttrs(
  pair: { dark: string; light?: string | null } | null | undefined,
): Record<string, string> {
  return seasonOptionAttrs(pair ? { logo_url: pair.dark, logo_url_light: pair.light ?? null } : null);
}
