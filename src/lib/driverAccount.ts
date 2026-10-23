/**
 * Linking a site account to its roster driver (U2 driver-linking; contracts C1 and C2).
 * The rules live in the database (20261027120000_driver_linking.sql): link_my_driver, list_unlinked_drivers,
 * my_link_state and submit_driver_request run as SECURITY DEFINER functions under the caller's own token, and
 * raise '<CODE>: <message>' for the outcomes the linking page explains. This module calls them, turns those
 * errors into typed codes, and shapes form input before it reaches the database.
 */

import type { SupabaseEnv } from './db/client';

export const DRIVER_ACCOUNT_ERROR_CODES = [
  'NOT_AUTHENTICATED',
  'ALREADY_LINKED',
  'DRIVER_TAKEN',
  'NOT_FOUND',
  'REQUEST_PENDING',
  'REQUEST_LIMIT',
  'CAR_NUMBER_TAKEN',
  'IRACING_ID_TAKEN',
  'INVALID',
  'REQUESTER_ALREADY_LINKED',
  'DRIVER_ALREADY_LINKED',
] as const;

export type DriverAccountErrorCode = (typeof DRIVER_ACCOUNT_ERROR_CODES)[number] | 'UNKNOWN';

/** The website request form's fields, as the database names them in INVALID errors. */
export type RequestField = 'name' | 'car_number' | 'iracing_cust_id';

const REQUEST_FIELDS: readonly RequestField[] = ['name', 'car_number', 'iracing_cust_id'];

export interface MappedDbError {
  code: DriverAccountErrorCode;
  /** The field an INVALID error names, else null. */
  field: RequestField | null;
  /** The database's message after the code prefix, written to be read by a person. */
  detail: string;
}

/** An outcome of a linking call; `code` decides what the page shows. */
export class DriverAccountError extends Error {
  readonly code: DriverAccountErrorCode;
  readonly field: RequestField | null;

  constructor(mapped: MappedDbError) {
    super(mapped.detail || mapped.code);
    this.name = 'DriverAccountError';
    this.code = mapped.code;
    this.field = mapped.field;
  }
}

const KNOWN_CODES = new Set<string>(DRIVER_ACCOUNT_ERROR_CODES);
const UNIQUE_LINK_INDEX = 'profiles_driver_id_unique';

interface PostgrestErrorBody {
  code?: unknown;
  message?: unknown;
  details?: unknown;
}

/** The PostgREST error body inside a thrown error's text, when there is one ("... (409): {...}"). */
function embeddedBody(text: string): PostgrestErrorBody | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start));
    return parsed && typeof parsed === 'object' ? (parsed as PostgrestErrorBody) : null;
  } catch {
    return null;
  }
}

function errorParts(err: unknown): { message: string; pgCode: string; details: string } {
  let body: PostgrestErrorBody | null = null;
  let message = '';
  if (typeof err === 'string') {
    message = err;
    body = embeddedBody(err);
  } else if (err instanceof Error) {
    message = err.message;
    body = embeddedBody(err.message);
  } else if (err && typeof err === 'object') {
    body = err as PostgrestErrorBody;
  }
  if (body && typeof body.message === 'string') message = body.message;
  return {
    message,
    pgCode: body && typeof body.code === 'string' ? body.code : '',
    details: body && typeof body.details === 'string' ? body.details : '',
  };
}

/**
 * Maps a database error (a PostgREST error body, an Error carrying one, or its text) to a code. Functions raise
 * '<CODE>: <message>'; a unique violation on the one-account-per-driver index (Admin > Users setting a driver
 * another account holds) is DRIVER_ALREADY_LINKED; anything else is UNKNOWN.
 */
export function mapDbError(err: unknown): MappedDbError {
  const { message, pgCode, details } = errorParts(err);
  const prefixed = /^([A-Z_]+):\s*([\s\S]*)$/.exec(message.trim());
  if (prefixed && KNOWN_CODES.has(prefixed[1])) {
    const code = prefixed[1] as DriverAccountErrorCode;
    let detail = prefixed[2].trim();
    let field: RequestField | null = null;
    if (code === 'INVALID') {
      const named = /^([a-z_]+):\s*([\s\S]*)$/.exec(detail);
      if (named && (REQUEST_FIELDS as readonly string[]).includes(named[1])) {
        field = named[1] as RequestField;
        detail = named[2].trim();
      }
    }
    return { code, field, detail };
  }
  if (pgCode === '23505' && `${message} ${details}`.includes(UNIQUE_LINK_INDEX)) {
    return { code: 'DRIVER_ALREADY_LINKED', field: null, detail: message };
  }
  return { code: 'UNKNOWN', field: null, detail: message };
}

/** Logs the outcome code only: never names, emails or request bodies (NFR9.1). */
function logFailure(fn: string, code: DriverAccountErrorCode): void {
  // Expected under contention or abuse; warn so they can be searched for without paging anyone.
  if (code === 'REQUEST_LIMIT' || code === 'DRIVER_TAKEN') console.warn(`${fn} failed`, code);
  else console.error(`${fn} failed`, code);
}

async function readErrorBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Calls a self-service function as the signed-in user; failures become a DriverAccountError. */
async function userRpc<T>(
  env: SupabaseEnv,
  accessToken: string,
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${env.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: env.anonKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
  } catch {
    logFailure(fn, 'UNKNOWN');
    throw new DriverAccountError({
      code: 'UNKNOWN',
      field: null,
      detail: 'The database could not be reached',
    });
  }
  if (!res.ok) {
    const mapped = mapDbError(await readErrorBody(res));
    logFailure(fn, mapped.code);
    throw new DriverAccountError(mapped);
  }
  return (await res.json()) as T;
}

/** The code of any error a linking call threw. */
export function errorCodeOf(err: unknown): DriverAccountErrorCode {
  return err instanceof DriverAccountError ? err.code : mapDbError(err).code;
}

// --- Reads ---------------------------------------------------------------------------------------

export interface LinkRequest {
  status: 'pending' | 'rejected';
  name: string;
  carNumber: number | null;
  reason: string | null;
}

export interface LinkState {
  linked: boolean;
  driverId: string | null;
  /** The latest website request while it is pending, or rejected and not superseded. */
  request: LinkRequest | null;
}

export interface UnlinkedDriver {
  id: string;
  name: string;
  car_number: number | null;
}

/** Reads my_link_state's JSON defensively: anything unexpected is treated as no request. */
export function parseLinkState(raw: unknown): LinkState {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const driverId = typeof obj.driver_id === 'string' ? obj.driver_id : null;
  const req =
    obj.request && typeof obj.request === 'object' ? (obj.request as Record<string, unknown>) : null;
  const status = req?.status === 'pending' || req?.status === 'rejected' ? req.status : null;
  return {
    linked: obj.linked === true || driverId !== null,
    driverId,
    request:
      req && status
        ? {
            status,
            name: typeof req.name === 'string' ? req.name : '',
            carNumber: typeof req.car_number === 'number' ? req.car_number : null,
            reason: typeof req.reason === 'string' ? req.reason : null,
          }
        : null,
  };
}

export async function getLinkState(env: SupabaseEnv, accessToken: string): Promise<LinkState> {
  return parseLinkState(await userRpc<unknown>(env, accessToken, 'my_link_state', {}));
}

export function listUnlinkedDrivers(env: SupabaseEnv, accessToken: string): Promise<UnlinkedDriver[]> {
  return userRpc<UnlinkedDriver[]>(env, accessToken, 'list_unlinked_drivers', {});
}

export interface LinkPageData {
  state: LinkState | null;
  drivers: UnlinkedDriver[];
  /** True when either read failed; the page then shows its load error instead of throwing. */
  loadError: boolean;
}

/** What /link-driver renders: the link state and the list, read in parallel (NFR3.2, NFR4.2). */
export async function loadLinkPage(env: SupabaseEnv, accessToken: string): Promise<LinkPageData> {
  const [state, drivers] = await Promise.allSettled([
    getLinkState(env, accessToken),
    listUnlinkedDrivers(env, accessToken),
  ]);
  return {
    state: state.status === 'fulfilled' ? state.value : null,
    drivers: drivers.status === 'fulfilled' ? drivers.value : [],
    loadError: state.status === 'rejected' || drivers.status === 'rejected',
  };
}

// --- Writes --------------------------------------------------------------------------------------

/** Links the signed-in account to a driver, once. Resolves to the linked driver's id. */
export async function linkMyDriver(env: SupabaseEnv, accessToken: string, driverId: string): Promise<string> {
  const result = await userRpc<{ driver_id?: unknown }>(env, accessToken, 'link_my_driver', {
    p_driver_id: driverId,
  });
  return typeof result?.driver_id === 'string' ? result.driver_id : driverId;
}

export interface DriverRequestInput {
  name: string;
  carNumber: number;
  iracingCustId: number;
}

/** Sends a website request for a new driver entry. Resolves to the request id. */
export function submitDriverRequest(
  env: SupabaseEnv,
  accessToken: string,
  input: DriverRequestInput,
): Promise<string> {
  return userRpc<string>(env, accessToken, 'submit_driver_request', {
    p_name: input.name,
    p_car_number: input.carNumber,
    p_iracing_cust_id: input.iracingCustId,
  });
}

// --- Input shaping (NFR1.9; the database repeats every check) ------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A driver id from a form, or null unless it is a UUID. */
export function parseDriverId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return UUID.test(value) ? value.toLowerCase() : null;
}

export interface RequestFormValues {
  name: string;
  car_number: string;
  iracing_cust_id: string;
}

export type ShapedRequest =
  | { ok: true; input: DriverRequestInput; values: RequestFormValues }
  | { ok: false; field: RequestField; message: string; values: RequestFormValues };

export const REQUEST_FIELD_MESSAGES: Record<RequestField, string> = {
  name: 'Enter your full name (up to 80 characters).',
  car_number: 'Enter a car number from 0 to 999.',
  iracing_cust_id: 'Enter your iRacing customer ID (a whole number).',
};

const formText = (raw: unknown) => (typeof raw === 'string' ? raw : '');

/**
 * Shapes the request form: the name has control characters removed and is trimmed to 1-80 characters; the car
 * number is a whole number 0-999; the iRacing id a positive whole number. `values` echoes what was typed (name
 * cleaned) so the form can keep it after an error.
 */
export function shapeRequestInput(form: {
  name: unknown;
  car_number: unknown;
  iracing_cust_id: unknown;
}): ShapedRequest {
  const name = formText(form.name)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  const carNumberText = formText(form.car_number).trim();
  const iracingText = formText(form.iracing_cust_id).trim();
  const values: RequestFormValues = { name, car_number: carNumberText, iracing_cust_id: iracingText };
  const fail = (field: RequestField): ShapedRequest => ({
    ok: false,
    field,
    message: REQUEST_FIELD_MESSAGES[field],
    values,
  });

  if (name.length < 1 || name.length > 80) return fail('name');
  if (!/^\d{1,3}$/.test(carNumberText)) return fail('car_number');
  const iracingCustId = Number(iracingText);
  if (!/^\d{1,16}$/.test(iracingText) || !Number.isSafeInteger(iracingCustId) || iracingCustId <= 0) {
    return fail('iracing_cust_id');
  }
  return { ok: true, input: { name, carNumber: Number(carNumberText), iracingCustId }, values };
}

// --- Messages (the functional spec's error catalogue) --------------------------------------------

export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Try again.';
export const LOAD_ERROR_MESSAGE = "Couldn't load the driver list. Try refreshing the page.";

/** What the linking page says when a link fails (ALREADY_LINKED and NOT_AUTHENTICATED redirect instead). */
export function linkErrorMessage(code: DriverAccountErrorCode, driverName?: string | null): string {
  if (code === 'DRIVER_TAKEN') {
    return `${driverName?.trim() || 'That driver'} was just linked to another account. Pick your driver again.`;
  }
  if (code === 'NOT_FOUND') return "That driver can't be linked.";
  return GENERIC_ERROR_MESSAGE;
}

/** The message for a failed request and the field it belongs under (null: shown above the form). */
export function requestErrorMessage(
  err: { code: DriverAccountErrorCode; field: RequestField | null },
  carNumber?: number,
): { field: RequestField | null; message: string } {
  switch (err.code) {
    case 'REQUEST_PENDING':
      return { field: null, message: 'You already have a request waiting for an admin.' };
    case 'REQUEST_LIMIT':
      return { field: null, message: 'You have sent three requests today. Try again tomorrow.' };
    case 'CAR_NUMBER_TAKEN':
      return {
        field: 'car_number',
        message:
          carNumber === undefined
            ? 'That car number already belongs to a driver.'
            : `Car number ${carNumber} already belongs to a driver.`,
      };
    case 'IRACING_ID_TAKEN':
      return { field: 'iracing_cust_id', message: 'That iRacing customer ID already belongs to a driver.' };
    case 'INVALID':
      return err.field
        ? { field: err.field, message: REQUEST_FIELD_MESSAGES[err.field] }
        : { field: null, message: GENERIC_ERROR_MESSAGE };
    default:
      return { field: null, message: GENERIC_ERROR_MESSAGE };
  }
}

/** Admin pages show the database's own message; this drops the code prefix and names the unique-link clash. */
export function adminLinkErrorMessage(err: unknown): string | null {
  const mapped = mapDbError(err);
  if (
    mapped.code === 'DRIVER_ALREADY_LINKED' &&
    !/^DRIVER_ALREADY_LINKED:/.test(errorParts(err).message.trim())
  ) {
    return 'That driver is already linked to another account.';
  }
  if (mapped.code !== 'UNKNOWN') return `${mapped.detail.replace(/\.$/, '')}.`;
  return null;
}
