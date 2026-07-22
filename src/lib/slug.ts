/** Turns a title into a URL-safe slug — e.g. "Season 18 Kicks Off!" -> "season-18-kicks-off". */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
