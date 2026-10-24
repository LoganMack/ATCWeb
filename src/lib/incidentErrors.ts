/**
 * The error codes the incident-management database functions raise as '<CODE>: <message>'
 * (20261101120000_incident_management.sql): add_my_incident_comment and submit_incident_appeal.
 */

export const INCIDENT_ERROR_CODES = [
  'NOT_INVOLVED',
  'ALREADY_APPEALED',
  'ALREADY_COMMENTED',
  'CLOSED',
  'INVALID',
] as const;

export type IncidentErrorCode = (typeof INCIDENT_ERROR_CODES)[number];

const KNOWN = new Set<string>(INCIDENT_ERROR_CODES);

/** The message of a PostgREST error body inside a thrown error's text ("... 400 on fn: {...}"), else the text. */
function messageOf(text: string): string {
  const start = text.indexOf('{');
  if (start >= 0) {
    try {
      const body = JSON.parse(text.slice(start)) as { message?: unknown };
      if (body && typeof body.message === 'string') return body.message;
    } catch {
      // Not JSON: use the text as it is.
    }
  }
  return text;
}

/**
 * The known code an incident function raised, from a PostgREST error body, an Error carrying one, or its
 * message text; null for anything else (a network error, an old uncoded message).
 */
export function parseDbErrorCode(err: unknown): IncidentErrorCode | null {
  let message = '';
  if (typeof err === 'string') message = messageOf(err);
  else if (err instanceof Error) message = messageOf(err.message);
  else if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    message = (err as { message: string }).message;
  }
  const match = /^([A-Z_]+):/.exec(message.trim());
  return match && KNOWN.has(match[1]) ? (match[1] as IncidentErrorCode) : null;
}
