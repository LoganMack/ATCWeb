import { restDelete, restGet, restPatch, writeHeaders, type SupabaseEnv } from './client';

// --- Layout map details: incident pins + pit lane (0106_layout_map_details.sql) ---
// Read separately from CIRCUIT_LAYOUT_SELECT (same failure-tolerant approach as
// getCircuitCoordinates): that select feeds the whole site, so adding columns
// to it would break every page if this code shipped before the migration.

export type PitDifficulty = 'easy' | 'moderate' | 'difficult';
export const PIT_DIFFICULTY_LABELS: Record<PitDifficulty, string> = {
  easy: 'Easy',
  moderate: 'Moderate',
  difficult: 'Difficult',
};
export const PIT_NOTE_MAX = 140;

/** A point on the map, as percentages (0-100) from the image's top-left. */
export interface MapPoint {
  x: number;
  y: number;
}

export interface PitLaneInfo {
  difficulty: PitDifficulty | null;
  note: string | null;
  /** Where the entry/exit sits on the map — optional; the flag on the desktop map only shows when set. */
  point: MapPoint | null;
}

export interface LayoutPin extends MapPoint {
  id: string;
  penaltyId: string;
}

/** A numbered corner marked on a layout's map (layout_corners, 0110). x/y are percentages of the map image. */
export interface LayoutCorner {
  label: string;
  x: number;
  y: number;
}

export interface LayoutMapDetails {
  pitEntry: PitLaneInfo;
  pitExit: PitLaneInfo;
  pins: LayoutPin[];
  corners: LayoutCorner[];
}

export function emptyLayoutMapDetails(): LayoutMapDetails {
  return {
    pitEntry: { difficulty: null, note: null, point: null },
    pitExit: { difficulty: null, note: null, point: null },
    pins: [],
    corners: [],
  };
}

function asPitDifficulty(v: unknown): PitDifficulty | null {
  return v === 'easy' || v === 'moderate' || v === 'difficult' ? v : null;
}

function asMapPoint(x: unknown, y: unknown): MapPoint | null {
  if (x === null || y === null || x === undefined || y === undefined) return null;
  const nx = Number(x);
  const ny = Number(y);
  return Number.isFinite(nx) && Number.isFinite(ny) ? { x: nx, y: ny } : null;
}

/** Pit lane settings and incident pins for one layout. Never throws: an unapplied migration (or a failed query) just means no pit info and no pins. */
export async function getLayoutMapDetails(env: SupabaseEnv, layoutId: string): Promise<LayoutMapDetails> {
  const out = emptyLayoutMapDetails();
  const id = encodeURIComponent(layoutId);
  try {
    const rows = await restGet<
      {
        pit_entry_difficulty: string | null;
        pit_entry_note: string | null;
        pit_entry_x: number | null;
        pit_entry_y: number | null;
        pit_exit_difficulty: string | null;
        pit_exit_note: string | null;
        pit_exit_x: number | null;
        pit_exit_y: number | null;
      }[]
    >(
      env,
      `circuit_layouts_shown?select=pit_entry_difficulty,pit_entry_note,pit_entry_x,pit_entry_y,pit_exit_difficulty,pit_exit_note,pit_exit_x,pit_exit_y&id=eq.${id}`,
    );
    const r = rows[0];
    if (r) {
      out.pitEntry = {
        difficulty: asPitDifficulty(r.pit_entry_difficulty),
        note: r.pit_entry_note,
        point: asMapPoint(r.pit_entry_x, r.pit_entry_y),
      };
      out.pitExit = {
        difficulty: asPitDifficulty(r.pit_exit_difficulty),
        note: r.pit_exit_note,
        point: asMapPoint(r.pit_exit_x, r.pit_exit_y),
      };
    }
  } catch (err) {
    console.error('Failed to load pit lane details (is 0106_layout_map_details.sql applied?):', err);
  }
  try {
    const pins = await restGet<{ id: string; penalty_id: string; x: number; y: number }[]>(
      env,
      `layout_incident_pins?select=id,penalty_id,x,y&layout_id=eq.${id}&order=created_at.asc`,
    );
    out.pins = pins.map((p) => ({ id: p.id, penaltyId: p.penalty_id, x: Number(p.x), y: Number(p.y) }));
  } catch (err) {
    console.error('Failed to load layout incident pins (is 0106_layout_map_details.sql applied?):', err);
  }
  try {
    const corners = await restGet<{ label: string; x: number; y: number }[]>(
      env,
      `layout_corners?select=label,x,y&layout_id=eq.${id}&order=created_at.asc`,
    );
    out.corners = corners.map((c) => ({ label: c.label, x: Number(c.x), y: Number(c.y) }));
  } catch (err) {
    console.error('Failed to load layout corners (is 0110_layout_corners.sql applied?):', err);
  }
  return out;
}

export interface LayoutMapDetailsInput {
  pitEntry: PitLaneInfo;
  pitExit: PitLaneInfo;
  /** The full set of pins for this layout — pins not listed here are removed. */
  pins: { penaltyId: string; x: number; y: number }[];
  /** The full set of numbered corners for this layout — anything not listed is removed. */
  corners: LayoutCorner[];
}

const clampPercent = (n: number) => Math.min(100, Math.max(0, Math.round(n * 100) / 100));

/** Admin save for the map editor: pit lane fields on the layout, and the layout's whole pin list (upserted per incident; anything no longer listed is deleted). */
export async function saveLayoutMapDetails(
  env: SupabaseEnv,
  accessToken: string,
  layoutId: string,
  input: LayoutMapDetailsInput,
): Promise<void> {
  const note = (n: string | null) => {
    const t = (n ?? '').trim().slice(0, PIT_NOTE_MAX);
    return t ? t : null;
  };
  await restPatch<unknown>(env, accessToken, `circuit_layouts?id=eq.${encodeURIComponent(layoutId)}`, {
    pit_entry_difficulty: input.pitEntry.difficulty,
    pit_entry_note: note(input.pitEntry.note),
    pit_entry_x: input.pitEntry.point ? clampPercent(input.pitEntry.point.x) : null,
    pit_entry_y: input.pitEntry.point ? clampPercent(input.pitEntry.point.y) : null,
    pit_exit_difficulty: input.pitExit.difficulty,
    pit_exit_note: note(input.pitExit.note),
    pit_exit_x: input.pitExit.point ? clampPercent(input.pitExit.point.x) : null,
    pit_exit_y: input.pitExit.point ? clampPercent(input.pitExit.point.y) : null,
  });

  const keep = new Set(input.pins.map((p) => p.penaltyId));
  const existing = await restGet<{ id: string; penalty_id: string }[]>(
    env,
    `layout_incident_pins?select=id,penalty_id&layout_id=eq.${encodeURIComponent(layoutId)}`,
  );
  for (const row of existing) {
    if (!keep.has(row.penalty_id)) {
      await restDelete(env, accessToken, `layout_incident_pins?id=eq.${encodeURIComponent(row.id)}`);
    }
  }
  if (input.pins.length > 0) {
    const res = await fetch(`${env.url}/rest/v1/layout_incident_pins?on_conflict=penalty_id`, {
      method: 'POST',
      headers: writeHeaders(env, accessToken, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(
        input.pins.map((p) => ({
          layout_id: layoutId,
          penalty_id: p.penaltyId,
          x: clampPercent(p.x),
          y: clampPercent(p.y),
        })),
      ),
    });
    if (!res.ok)
      throw new Error(`Supabase upsert error ${res.status} on layout_incident_pins: ${await res.text()}`);
  }

  // Corners: an unapplied 0110 migration must not break saving the rest, so only fail if corners were actually given.
  const existingCorners = await restGet<{ id: string; label: string }[]>(
    env,
    `layout_corners?select=id,label&layout_id=eq.${encodeURIComponent(layoutId)}`,
  ).catch(() => null);
  if (existingCorners === null) {
    if (input.corners.length > 0)
      throw new Error('Corners can’t be saved yet — run migration 0110_layout_corners.sql first.');
    return;
  }
  const keepLabels = new Set(input.corners.map((c) => c.label));
  for (const row of existingCorners) {
    if (!keepLabels.has(row.label))
      await restDelete(env, accessToken, `layout_corners?id=eq.${encodeURIComponent(row.id)}`);
  }
  if (input.corners.length > 0) {
    const res = await fetch(`${env.url}/rest/v1/layout_corners?on_conflict=layout_id,label`, {
      method: 'POST',
      headers: writeHeaders(env, accessToken, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(
        input.corners.map((c) => ({
          layout_id: layoutId,
          label: c.label,
          x: clampPercent(c.x),
          y: clampPercent(c.y),
        })),
      ),
    });
    if (!res.ok)
      throw new Error(`Supabase upsert error ${res.status} on layout_corners: ${await res.text()}`);
  }
}
