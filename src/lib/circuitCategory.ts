/**
 * Layout categories (circuit_layouts.category) and circuit logo colours (circuits.logo_background).
 * The database CHECKs in 20261123120000_layout_category_and_logo_colour.sql hold the same values; this module
 * holds the labels and the parsing of admin form input. Pure, so pages, scripts and tests can share it.
 */

/** Stored keys in display order: the Track Type split lists its rows in this order. */
export const LAYOUT_CATEGORIES = ['oval', 'roval', 'road_long', 'road_short', 'street'] as const;

export type LayoutCategory = (typeof LAYOUT_CATEGORIES)[number];

/** Same list under the contract's name, for callers that order rows by it. */
export const LAYOUT_CATEGORY_ORDER: readonly LayoutCategory[] = LAYOUT_CATEGORIES;

export const LAYOUT_CATEGORY_LABELS: Readonly<Record<LayoutCategory, string>> = {
  oval: 'Oval',
  roval: 'Roval',
  road_long: 'Road Course (Long)',
  road_short: 'Road Course (Short)',
  street: 'Street Course',
};

export function isLayoutCategory(value: unknown): value is LayoutCategory {
  return typeof value === 'string' && (LAYOUT_CATEGORIES as readonly string[]).includes(value);
}

/** A logo plate colour as stored: lower-case `#rrggbb`. */
export type HexColour = `#${string}`;

const HEX_COLOUR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_COLOUR = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;

function hexByte(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/**
 * Lower-case `#rrggbb` from `#RGB`, `#RRGGBB` or `rgb(r, g, b)` (components 0-255), any case, surrounding
 * spaces ignored; null for anything else. The result is rebuilt from the parsed digits and never echoes the
 * input, so only `#` plus six hex digits can reach a style attribute.
 */
export function normaliseLogoColour(value: unknown): HexColour | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();

  const hex = HEX_COLOUR.exec(text);
  if (hex) {
    const digits = hex[1].toLowerCase();
    const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits;
    return `#${full}`;
  }

  const rgb = RGB_COLOUR.exec(text);
  if (rgb) {
    const parts = [rgb[1], rgb[2], rgb[3]].map(Number);
    if (parts.some((n) => n > 255)) return null;
    return `#${parts.map(hexByte).join('')}`;
  }

  return null;
}

const STORED_COLOUR = /^#[0-9a-f]{6}$/;

/**
 * True only for the exact stored form (`#` plus six lower-case hex digits). Used on read and render, so a
 * value written outside the app can never reach a style attribute unless it already has that shape.
 */
export function isStoredLogoColour(value: unknown): value is HexColour {
  return typeof value === 'string' && STORED_COLOUR.test(value);
}

/** Half up to at most three decimals; the exponent form avoids binary rounding (4.0235 -> 4.024). */
function roundKm(n: number): number {
  const rounded = Number(`${Math.round(Number(`${n}e3`))}e-3`);
  // A value already printed in exponent form (tiny or huge) makes the string trick NaN.
  return Number.isNaN(rounded) ? Math.round(n * 1000) / 1000 : rounded;
}

/** "5.79 km, 19 corners" for a layout row; a missing part is left out, and null when both are missing. */
export function formatLayoutSubtitle(lengthKm: number | null, corners: number | null): string | null {
  const parts: string[] = [];
  if (lengthKm !== null && Number.isFinite(lengthKm)) parts.push(`${roundKm(lengthKm)} km`);
  if (corners !== null && Number.isFinite(corners)) parts.push(corners === 1 ? '1 corner' : `${corners} corners`);
  return parts.length > 0 ? parts.join(', ') : null;
}
