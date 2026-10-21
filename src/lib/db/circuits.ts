import { restDelete, restGet, restPatch, restPost, type SupabaseEnv } from './client';

// ---------------------------------------------------------------------------
// CALENDAR — circuits + events
// ---------------------------------------------------------------------------

// --- Circuits ------------------------------------------------------------

export interface Circuit {
  id: string;
  name: string;
  logo_url: string | null;
  location: string | null;
}

const CIRCUIT_SELECT = 'id,name,logo_url,location';

export function getCircuits(env: SupabaseEnv) {
  return restGet<Circuit[]>(env, `circuits?select=${CIRCUIT_SELECT}&order=name.asc`);
}

/**
 * Latitude/longitude per circuit (0098_circuit_coordinates.sql) for the
 * Calendar's Map view. Deliberately a separate, failure-tolerant query rather
 * than part of CIRCUIT_SELECT: that select feeds the whole site, and adding
 * columns to it would break every page if this code were ever deployed before
 * the migration is applied. Returns an empty list in that case, so the map just
 * shows "no locations yet" instead of anything else breaking.
 */
export async function getCircuitCoordinates(
  env: SupabaseEnv,
): Promise<{ id: string; latitude: number | null; longitude: number | null }[]> {
  try {
    return await restGet<{ id: string; latitude: number | null; longitude: number | null }[]>(
      env,
      'circuits?select=id,latitude,longitude',
    );
  } catch (err) {
    console.error('Failed to load circuit coordinates (is 0098_circuit_coordinates.sql applied?):', err);
    return [];
  }
}

export type LogoBackground = 'light' | 'dark';

/**
 * Per-circuit plate behind the primary track logo (0103_circuit_logo_background.sql),
 * chosen on /admin/circuits/<id> for logos that disappear into one of the
 * themes (a dark logo on the dark theme, a white one on the light theme).
 * Keyed by circuit id; circuits with no plate are simply absent. Separate,
 * failure-tolerant query for the same reason as getCircuitCoordinates: this
 * must never break a page if the code is deployed before the migration.
 */
export async function getCircuitLogoBackgrounds(env: SupabaseEnv): Promise<Record<string, LogoBackground>> {
  try {
    const rows = await restGet<{ id: string; logo_background: string | null }[]>(
      env,
      'circuits?select=id,logo_background&logo_background=not.is.null',
    );
    const out: Record<string, LogoBackground> = {};
    for (const r of rows) {
      if (r.logo_background === 'light' || r.logo_background === 'dark') out[r.id] = r.logo_background;
    }
    return out;
  } catch (err) {
    console.error(
      'Failed to load circuit logo backgrounds (is 0103_circuit_logo_background.sql applied?):',
      err,
    );
    return {};
  }
}

/** Attributes to spread onto a track-logo <img>: global.css draws the chosen plate behind it (see `data-logo-bg`). Empty when no plate is set. */
export function logoBgAttrs(bg: LogoBackground | null | undefined): Record<string, string> {
  return bg ? { 'data-logo-bg': bg } : {};
}

export async function getCircuitById(env: SupabaseEnv, id: string) {
  const circuits = await restGet<Circuit[]>(
    env,
    `circuits?select=${CIRCUIT_SELECT}&id=eq.${encodeURIComponent(id)}`,
  );
  return circuits[0] ?? null;
}

export function createCircuit(
  env: SupabaseEnv,
  accessToken: string,
  data: Partial<Circuit> & { latitude?: number | null; longitude?: number | null },
) {
  return restPost<Circuit>(env, accessToken, 'circuits', data);
}

export function updateCircuit(
  env: SupabaseEnv,
  accessToken: string,
  id: string,
  data: Partial<Circuit> & {
    latitude?: number | null;
    longitude?: number | null;
    logo_background?: LogoBackground | null;
  },
) {
  return restPatch<Circuit>(env, accessToken, `circuits?id=eq.${encodeURIComponent(id)}`, data);
}

export function deleteCircuit(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `circuits?id=eq.${encodeURIComponent(id)}`);
}

// --- Circuit layouts (lap records, see 0010_circuit_layouts.sql) -----------

export interface CircuitLayout {
  id: string;
  circuit_id: string;
  name: string;
  length_km: number | null;
  /** Raw seconds, to the nearest thousandth (e.g. 102.512) — as imported. Use `formatLapTime()` to display it as "01:42.512". */
  lap_record_seconds: number | null;
  lap_record_holder: string | null;
  lap_record_date: string | null; // 'YYYY-MM-DD'
  /** This specific layout's own image (e.g. its track map) — see 0021_circuit_layout_image.sql. Only shown when the parent circuit has no logo_url; use `layoutImageUrl()`. */
  image_url: string | null;
  /** Number of corners on this layout, admin-entered — see 0022_circuit_layout_corners.sql. Powers the Standings page's season "corners per incident" stat (src/lib/results.ts's getSeasonDriverExtendedStats); null until Logan fills it in for a given layout. */
  corners: number | null;
}

const CIRCUIT_LAYOUT_SELECT =
  'id,circuit_id,name,length_km,lap_record_seconds,lap_record_holder,lap_record_date,image_url,corners';

/** "1:42.512" from a raw seconds count (e.g. 102.512) — minutes are shown with no leading zero (per site-wide convention: no leading zeroes on lap records/times), while seconds/milliseconds keep their own fixed-width zero-padding since those are always exactly 2 and 3 digits within a minute. */
export function formatLapTime(seconds: number | null): string {
  if (seconds === null) return '—';
  const totalMs = Math.round(seconds * 1000);
  const minutes = Math.floor(totalMs / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${minutes}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/**
 * "Full Course" from the "N/A" sentinel some circuit layouts are stored
 * with (used when a circuit only has one configuration and no specific
 * layout name applies) — display-only, doesn't touch the stored value.
 */
export function displayLayoutName(name: string): string {
  return name === 'N/A' ? 'Full Course' : name;
}

/** The parent circuit's primary logo; a layout's own image is only a fallback for circuits that have no logo yet (or null if neither exists). */
export function layoutImageUrl(
  layout: Pick<CircuitLayout, 'image_url'>,
  circuit: Pick<Circuit, 'logo_url'> | null,
): string | null {
  return circuit?.logo_url ?? layout.image_url ?? null;
}

/**
 * Same order as layoutImageUrl (the circuit's primary logo first, a
 * layout's own image only as a fallback), but for an *event* rather than a
 * CircuitLayout row directly — events.layout is a plain text name (no FK to
 * circuit_layouts, see that column's own comment on EventRecord below), so
 * this looks the matching layout up out of a full layouts list by
 * (circuit_id, name) instead of already holding a layout row. Used
 * everywhere an event/calendar card shows a circuit image.
 */
export function eventImageUrl(
  event: { circuit_id: string | null; layout: string | null },
  circuit: Pick<Circuit, 'logo_url'> | null,
  layouts: Pick<CircuitLayout, 'circuit_id' | 'name' | 'image_url'>[],
): string | null {
  // HOLIDAY/IRACING events have no circuit_id at all (see EventRecord.title
  // below) — they're never supposed to show a logo, and a null circuit_id
  // simply never matches any layouts[] row here, so this falls straight
  // through to circuit?.logo_url ?? null, which is also null for them.
  const matchedLayout = event.layout
    ? layouts.find((l) => l.circuit_id === event.circuit_id && l.name === event.layout)
    : undefined;
  return circuit?.logo_url ?? matchedLayout?.image_url ?? null;
}

/**
 * Pulls the 11-character video ID out of any of the URL shapes YouTube
 * hands out (watch?v=, youtu.be/, /embed/, /shorts/) — every video entry on
 * the Media page (admin-entered or derived from race_links.broadcast_url)
 * is expected to be a YouTube link, per Logan. Returns null for anything
 * that doesn't match, so callers can fall back to a plain "watch" link
 * instead of a broken thumbnail/embed.
 */
export function youtubeVideoId(url: string): string | null {
  // youtube.com/live/VIDEO_ID is the URL format YouTube's own "Share" button
  // gives you for a livestream — both while it's live AND permanently
  // afterward, once it's just a normal archived video at the same URL. It
  // was missing from this list entirely, which is why broadcasts linked
  // with that URL shape (Media > Videos > Broadcasts) never matched any
  // branch here and silently got no thumbnail at all.
  const match = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/.exec(url);
  return match ? match[1] : null;
}

/** YouTube's predictable thumbnail URL for a video, or null if the ID couldn't be parsed out of the given URL — see youtubeVideoId. */
export function youtubeThumbnailUrl(url: string): string | null {
  const id = youtubeVideoId(url);
  return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null;
}

/**
 * "Chris Macdonald" from "Chris Macdonald5" — iRacing appends a trailing
 * number directly to a driver's name to disambiguate real-name duplicates
 * on the roster (see 0001_init.sql's `name` column comment). Display-only:
 * never use this to write back to the stored `name` value, since the
 * driver record needs to keep the exact iRacing-supplied name to stay
 * aligned with iRacing (and unique in the database).
 */
export function displayDriverName(name: string): string {
  return name.replace(/\d+$/, '');
}

/**
 * "J. Smith" from "John Smith" — or from "John Michael Smith"/"John M.
 * Smith"/any other number of middle names or initials in between, since
 * this only ever keeps the FIRST token's initial and the LAST token
 * verbatim, dropping everything in between rather than risking a middle
 * name/initial getting mistaken for the surname. Built on
 * `displayDriverName` so the trailing disambiguator digit (see that
 * function's own doc comment) is already gone before splitting on
 * whitespace. Standings page's Matrix view — its Driver column has far
 * less room once the round columns take over most of the table's width;
 * everywhere else on the site still shows the full name via
 * `displayDriverName`.
 */
export function shortDriverName(name: string): string {
  const parts = displayDriverName(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts[0].charAt(0)}. ${parts[parts.length - 1]}`;
}

/**
 * "August 5, 2026" — the one date format used everywhere across the site,
 * from a 'YYYY-MM-DD' date-only string or a full ISO timestamp.
 * Date-only strings are parsed as local calendar-date components rather
 * than handed straight to `new Date()`, which treats a bare 'YYYY-MM-DD'
 * as UTC midnight and can render as the *previous* day once
 * `toLocaleDateString` applies a negative-offset local timezone.
 */
export function formatDate(dateInput: string | null): string {
  if (!dateInput) return '—';
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateInput);
  const date = dateOnlyMatch
    ? new Date(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]))
    : new Date(dateInput);
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/** Same date-parsing as formatDate, but an abbreviated month for tight columns (the roster's Signed Up column: "Sep 13, 2025" instead of "September 13, 2025"). Kept as its own function rather than a formatDate param so every existing formatDate call site is untouched. */
export function formatDateShort(dateInput: string | null): string {
  if (!dateInput) return '—';
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateInput);
  const date = dateOnlyMatch
    ? new Date(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]))
    : new Date(dateInput);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function getCircuitLayouts(env: SupabaseEnv, circuitId: string) {
  return restGet<CircuitLayout[]>(
    env,
    `circuit_layouts?select=${CIRCUIT_LAYOUT_SELECT}&circuit_id=eq.${encodeURIComponent(circuitId)}&order=name.asc`,
  );
}

/** Every layout for every circuit in one query — powers the public Circuits page, which needs all of them up front rather than one request per circuit. */
export function getAllCircuitLayouts(env: SupabaseEnv) {
  return restGet<CircuitLayout[]>(
    env,
    `circuit_layouts?select=${CIRCUIT_LAYOUT_SELECT}&order=circuit_id.asc,name.asc`,
  );
}

/** One layout by id — powers the Circuits page's per-row lazy detail fragment (src/pages/circuits/layout-detail/[layoutId].astro), which only needs the single layout a visitor just expanded rather than every layout on the site. */
export async function getCircuitLayoutById(env: SupabaseEnv, id: string) {
  const rows = await restGet<CircuitLayout[]>(
    env,
    `circuit_layouts?select=${CIRCUIT_LAYOUT_SELECT}&id=eq.${encodeURIComponent(id)}`,
  );
  return rows[0] ?? null;
}

export function createCircuitLayout(env: SupabaseEnv, accessToken: string, data: Partial<CircuitLayout>) {
  return restPost<CircuitLayout>(env, accessToken, 'circuit_layouts', data);
}

export function updateCircuitLayout(
  env: SupabaseEnv,
  accessToken: string,
  id: string,
  data: Partial<CircuitLayout>,
) {
  return restPatch<CircuitLayout>(env, accessToken, `circuit_layouts?id=eq.${encodeURIComponent(id)}`, data);
}

export function deleteCircuitLayout(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `circuit_layouts?id=eq.${encodeURIComponent(id)}`);
}

// --- Track guides (one-to-many per layout, see 0053_track_guides.sql) ------
// Replaces the old single circuit_layouts.track_guide_url column — a layout
// can now have any number of guide videos. Managed independently of the
// layout's own metadata form on the admin Circuits page (its own add/remove
// mini-list), shown grouped by layout on the public Media page.

export interface TrackGuide {
  id: string;
  layout_id: string;
  title: string | null;
  url: string;
  sort_order: number;
}

const TRACK_GUIDE_SELECT = 'id,layout_id,title,url,sort_order';

export function getTrackGuidesForLayout(env: SupabaseEnv, layoutId: string) {
  return restGet<TrackGuide[]>(
    env,
    `track_guides?select=${TRACK_GUIDE_SELECT}&layout_id=eq.${encodeURIComponent(layoutId)}&order=sort_order.asc,created_at.asc`,
  );
}

/** Every track guide for every layout in one query — powers the public Media page's Track Guide filter, which needs all of them up front (grouped by layout in memory) rather than one request per layout. */
export function getAllTrackGuides(env: SupabaseEnv) {
  return restGet<TrackGuide[]>(
    env,
    `track_guides?select=${TRACK_GUIDE_SELECT}&order=layout_id.asc,sort_order.asc,created_at.asc`,
  );
}

export function createTrackGuide(env: SupabaseEnv, accessToken: string, data: Partial<TrackGuide>) {
  return restPost<TrackGuide>(env, accessToken, 'track_guides', data);
}

export function deleteTrackGuide(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `track_guides?id=eq.${encodeURIComponent(id)}`);
}
