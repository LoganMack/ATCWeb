/**
 * The New Driver Sign-Up popup's live car-number hint, shared by the page (src/lib/driverAccount.ts) and its
 * browser script (src/scripts/linkDriver.ts). No imports, so the script bundles nothing else.
 */

export interface CarNumberStatus {
  number: number;
  taken: boolean;
  /** "#n is available" or "#n is taken". */
  message: string;
}

/** Null until `raw` is a whole number 0-999; then whether `taken` holds it. */
export function carNumberStatus(raw: string, taken: readonly number[]): CarNumberStatus | null {
  const text = raw.trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const number = Number(text);
  const isTaken = taken.includes(number);
  return { number, taken: isTaken, message: `#${number} is ${isTaken ? 'taken' : 'available'}` };
}
