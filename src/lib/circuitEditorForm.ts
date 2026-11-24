/**
 * Parsing and validation for the admin circuit editor's forms (admin/circuits/[id].astro). Pure, so every
 * rule runs before the page writes anything and the tests need no request. Each parser returns the typed
 * strings as `state`, so a refused save re-renders exactly what was typed.
 */
import {
  isLayoutCategory,
  normaliseLogoColour,
  type HexColour,
  type LayoutCategory,
} from './circuitCategory';
import type { CircuitLayout, LayoutWrite, LogoBackground } from './db/circuits';

export const CIRCUIT_EDITOR_MESSAGES = {
  nameRequired: 'Circuit Name is required.',
  coordinates:
    'Latitude and longitude must both be numbers (latitude -90 to 90, longitude -180 to 180), or both left empty.',
  logoBackground: 'Logo Background: enter a colour like #4369f5 or rgb(67, 105, 245).',
  layoutNameRequired: 'Layout Name is required.',
  categoryRequired: 'Category is required.',
  lengthKm: 'Length (km) must be a number above 0 and at most 100.',
  corners: 'Corners must be a whole number from 0 to 200.',
  layoutGone: 'This layout no longer exists.',
} as const;

export type LogoBackgroundMode = 'none' | 'light' | 'dark' | 'custom';

/** `value` is absent when the choice is invalid (Custom with text that is not a colour). */
export interface LogoBackgroundChoice {
  mode: LogoBackgroundMode;
  text: string;
  value?: LogoBackground | null;
}

export interface CircuitFormState {
  name: string;
  location: string;
  latitude: string;
  longitude: string;
  logoBackgroundMode: LogoBackgroundMode;
  logoBackgroundText: string;
}

export interface CircuitWrite {
  name: string;
  location: string | null;
  /** Null when the coordinates are neither set nor cleared, so the columns are left alone. */
  coords: { latitude: number | null; longitude: number | null } | null;
  /** Present only when the plate changed (BR1.8). */
  logoBackground?: LogoBackground | null;
}

export type LayoutField = 'layout_name' | 'category' | 'length_km' | 'corners';

/** `field` is null for a refusal that belongs to no one field (a deleted layout, a database error). */
export interface LayoutFormError {
  field: LayoutField | null;
  message: string;
}

export interface LayoutFormState {
  dialogKey: string;
  name: string;
  category: string;
  lengthKm: string;
  corners: string;
  error: LayoutFormError | null;
}

const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
};

export function parseLogoBackgroundChoice(mode: string, typed: string): LogoBackgroundChoice {
  if (mode === 'light' || mode === 'dark') return { mode, text: typed, value: mode };
  if (mode === 'custom') {
    const colour: HexColour | null = normaliseLogoColour(typed);
    return colour ? { mode, text: typed, value: colour } : { mode, text: typed };
  }
  // '' and anything unexpected count as None.
  return { mode: 'none', text: typed, value: null };
}

function parseCoords(
  latRaw: string,
  lngRaw: string,
  hadCoords: boolean,
): { coords: CircuitWrite['coords']; error: string | null } {
  if (latRaw || lngRaw) {
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (
      !latRaw ||
      !lngRaw ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      return { coords: null, error: CIRCUIT_EDITOR_MESSAGES.coordinates };
    }
    return { coords: { latitude: lat, longitude: lng }, error: null };
  }
  // Only clear the columns when something was stored, so other saves never touch them.
  return { coords: hadCoords ? { latitude: null, longitude: null } : null, error: null };
}

export function parseCircuitForm(form: FormData): {
  state: CircuitFormState;
  error: string | null;
  write?: CircuitWrite;
} {
  const name = text(form, 'name');
  const location = text(form, 'location');
  const latitude = text(form, 'latitude');
  const longitude = text(form, 'longitude');
  const hadCoords = text(form, 'had_coords') === '1';
  const choice = parseLogoBackgroundChoice(text(form, 'logo_background'), text(form, 'logo_background_hex'));
  const hadLogoBackground = text(form, 'had_logo_background');

  const state: CircuitFormState = {
    name,
    location,
    latitude,
    longitude,
    logoBackgroundMode: choice.mode,
    logoBackgroundText: choice.text,
  };

  const trimmedName = name.trim();
  if (!trimmedName) return { state, error: CIRCUIT_EDITOR_MESSAGES.nameRequired };

  const { coords, error: coordsError } = parseCoords(latitude.trim(), longitude.trim(), hadCoords);
  if (coordsError) return { state, error: coordsError };

  if (choice.value === undefined) return { state, error: CIRCUIT_EDITOR_MESSAGES.logoBackground };

  const write: CircuitWrite = { name: trimmedName, location: location.trim() || null, coords };
  if ((choice.value ?? '') !== hadLogoBackground) write.logoBackground = choice.value;
  return { state, error: null, write };
}

function layoutError(state: LayoutFormState, field: LayoutField, message: string) {
  return { state: { ...state, error: { field, message } } };
}

export function parseLayoutForm(form: FormData): { state: LayoutFormState; write?: LayoutWrite } {
  const dialogKey = text(form, 'intent') === 'update-layout' ? text(form, 'layout_id') : 'new';
  const state: LayoutFormState = {
    dialogKey,
    name: text(form, 'layout_name'),
    category: text(form, 'category'),
    lengthKm: text(form, 'length_km'),
    corners: text(form, 'corners'),
    error: null,
  };

  const name = state.name.trim();
  if (!name) return layoutError(state, 'layout_name', CIRCUIT_EDITOR_MESSAGES.layoutNameRequired);

  const category = state.category;
  if (!isLayoutCategory(category)) {
    return layoutError(state, 'category', CIRCUIT_EDITOR_MESSAGES.categoryRequired);
  }

  const lengthRaw = state.lengthKm.trim();
  let lengthKm: number | null = null;
  if (lengthRaw) {
    // Plain decimals only: Number() would also take 1e-9 or 0x10, and a length that rounds to 0 km is refused.
    const n = Number(lengthRaw);
    if (!/^\d+(\.\d+)?$/.test(lengthRaw) || n < 0.001 || n > 100) {
      return layoutError(state, 'length_km', CIRCUIT_EDITOR_MESSAGES.lengthKm);
    }
    lengthKm = n;
  }

  const cornersRaw = state.corners.trim();
  let corners: number | null = null;
  if (cornersRaw) {
    const n = Number(cornersRaw);
    if (!/^\d+$/.test(cornersRaw) || n > 200) {
      return layoutError(state, 'corners', CIRCUIT_EDITOR_MESSAGES.corners);
    }
    corners = n;
  }

  // An explicit key list, so a posted lap record can never reach the write (BR1.17).
  const write: LayoutWrite = { name, category: category as LayoutCategory, length_km: lengthKm, corners };
  return { state, write };
}

export function layoutFormStateFor(layout: CircuitLayout): LayoutFormState {
  return {
    dialogKey: layout.id,
    name: layout.name,
    category: layout.category ?? '',
    lengthKm: layout.length_km === null ? '' : String(layout.length_km),
    corners: layout.corners === null ? '' : String(layout.corners),
    error: null,
  };
}

export function emptyLayoutFormState(): LayoutFormState {
  return { dialogKey: 'new', name: '', category: '', lengthKm: '', corners: '', error: null };
}

/** A PATCH that matched no row resolves to undefined: the layout was deleted elsewhere (BR1.19). */
export function layoutSaveOutcome(
  result: CircuitLayout | undefined,
): { ok: true } | { ok: false; error: string } {
  return result ? { ok: true } : { ok: false, error: CIRCUIT_EDITOR_MESSAGES.layoutGone };
}
