/**
 * The one password rule for sign-up and password reset. 72 bytes is the
 * bcrypt input limit Supabase Auth hashes with; anything past it would be
 * silently ignored, so it is counted in UTF-8 bytes, not characters.
 */

export const PASSWORD_MIN_CHARS = 10;
export const PASSWORD_MAX_BYTES = 72;
export const PASSWORD_RULE_MESSAGE = `Password must be at least ${PASSWORD_MIN_CHARS} characters and no longer than ${PASSWORD_MAX_BYTES} bytes (about ${PASSWORD_MAX_BYTES} plain letters or numbers).`;

/** Null when the password is acceptable, else the one shared message. */
export function validatePassword(password: string): string | null {
  if (typeof password !== 'string') return PASSWORD_RULE_MESSAGE;
  if ([...password].length < PASSWORD_MIN_CHARS) return PASSWORD_RULE_MESSAGE;
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) return PASSWORD_RULE_MESSAGE;
  return null;
}
