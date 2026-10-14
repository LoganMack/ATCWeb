/**
 * Matches the free-text "Turn" of an incident report ("10", "T10", "turn 5a",
 * "3 & 4", "10-12") to numbered corners on a layout's map (layout_corners, 0110).
 */

export interface MapCorner {
  label: string;
  x: number;
  y: number;
}

/** The corner labels a report's turn text mentions, lower-cased ("Turn 3/4" → ["3", "4"]; "T10-12" → ["10", "11", "12"]). Text with no numbers ("Esses") gives []. */
export function turnLabelsFrom(turn: string): string[] {
  let text = turn.toLowerCase().replace(/\b(turns?|corners?|t)\s*(?=\d)/g, ' ');
  const out: string[] = [];
  // Ranges first: "10-12", "10 to 12" (kept short so "1-20" isn't read as every corner).
  text = text.replace(/(\d+)\s*(?:-|–|to)\s*(\d+)/g, (_m, a: string, b: string) => {
    const from = Number(a);
    const to = Number(b);
    if (to > from && to - from <= 8) for (let n = from; n <= to; n++) out.push(String(n));
    else out.push(a, b);
    return ' ';
  });
  for (const m of text.matchAll(/(?<![a-z\d])(\d+[a-z]?)(?![a-z\d])/g)) out.push(m[1]);
  return [...new Set(out)];
}

/** The placed corners a report's turn text refers to. "5a" falls back to corner "5" when only that one is placed. */
export function matchCorners(turn: string, corners: MapCorner[]): MapCorner[] {
  const byLabel = new Map(corners.map((c) => [c.label.trim().toLowerCase(), c]));
  const found = new Map<string, MapCorner>();
  for (const label of turnLabelsFrom(turn)) {
    const hit = byLabel.get(label) ?? byLabel.get(label.replace(/[a-z]$/, ''));
    if (hit) found.set(hit.label, hit);
  }
  return [...found.values()];
}
