/**
 * The poll editor's Circuits dropdown (BR6.2): every layout, labelled "Track — Layout", or the track alone for
 * a circuit's only, unnamed layout, sorted by track then layout. Circuits with no layout rows offer nothing.
 */
import { displayLayoutName, type Circuit, type CircuitLayout } from '../db/circuits';
import type { LayoutChoice } from './types';

/** A layout stored as "N/A" or blank is the circuit's unnamed full course. */
function isUnnamed(name: string): boolean {
  const trimmed = name.trim();
  return trimmed === '' || trimmed === 'N/A';
}

export function layoutLabel(trackName: string, layoutName: string, onlyLayout: boolean): string {
  if (onlyLayout && isUnnamed(layoutName)) return trackName;
  return `${trackName} — ${displayLayoutName(layoutName.trim())}`;
}

export function layoutChoices(
  circuits: readonly Pick<Circuit, 'id' | 'name'>[],
  layouts: readonly Pick<CircuitLayout, 'id' | 'circuit_id' | 'name' | 'image_url'>[],
): LayoutChoice[] {
  const trackName = new Map(circuits.map((c) => [c.id, c.name]));
  const perCircuit = new Map<string, number>();
  for (const l of layouts) perCircuit.set(l.circuit_id, (perCircuit.get(l.circuit_id) ?? 0) + 1);
  const rows: (LayoutChoice & { track: string; layout: string })[] = [];
  for (const l of layouts) {
    const track = trackName.get(l.circuit_id);
    if (!track) continue;
    rows.push({
      id: l.id,
      label: layoutLabel(track, l.name, perCircuit.get(l.circuit_id) === 1),
      imageUrl: l.image_url ?? null,
      track,
      layout: displayLayoutName(l.name.trim()),
    });
  }
  rows.sort((a, b) => a.track.localeCompare(b.track) || a.layout.localeCompare(b.layout));
  return rows.map(({ id, label, imageUrl }) => ({ id, label, imageUrl }));
}
