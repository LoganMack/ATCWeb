/**
 * Linking a site account to its roster driver (U2 driver-linking; contracts C1 and C2).
 * The rules live in the database (20261027120000_driver_linking.sql): link_my_driver, list_unlinked_drivers,
 * my_link_state and submit_driver_request run as SECURITY DEFINER functions under the caller's own token, and
 * raise '<CODE>: <message>' for the outcomes the linking page explains. This module calls them, turns those
 * errors into typed codes, and shapes form input before it reaches the database. It also holds the account's
 * own settings and the own-profile controller (U3 profile-settings; contracts C3 and C4).
 */

import type { SupabaseEnv } from './db/client';
import {
  AuthRequestError,
  changeEmail,
  getUser,
  normaliseEmail,
  requestPasswordReset,
  type AuthUser,
} from './auth';
import {
  DRIVER_AVATAR_MAX_BYTES,
  DRIVER_AVATAR_TYPES,
  DRIVER_BIO_MAX,
  deleteDriverAvatar,
  updateMyDriverProfile,
  uploadDriverAvatar,
} from './db/drivers';
import {
  handleIncidentProfileIntent,
  INCIDENT_PROFILE_INTENTS,
  INCIDENT_STATUS_PARAM,
  type IncidentProfileIntent,
} from './incidentActions/profileIncidents';

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
  'RATE_LIMITED',
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
  if (code === 'REQUEST_LIMIT' || code === 'DRIVER_TAKEN' || code === 'RATE_LIMITED') {
    console.warn(`${fn} failed`, code);
  } else console.error(`${fn} failed`, code);
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

// --- Account settings (U3 profile-settings, contract C3) -----------------------------------------

/** The five choices, named as the account_settings columns and the form's checkboxes. */
export const ACCOUNT_SETTING_COLUMNS = [
  'hide_profile',
  'hide_name',
  'notify_appeal_reviewed',
  'notify_report_posted',
  'notify_event_reminders',
] as const;

export type AccountSettingColumn = (typeof ACCOUNT_SETTING_COLUMNS)[number];
export type AccountSettings = Record<AccountSettingColumn, boolean>;

/** A missing row means every choice is off (C3). */
export const DEFAULT_ACCOUNT_SETTINGS: Readonly<AccountSettings> = Object.freeze({
  hide_profile: false,
  hide_name: false,
  notify_appeal_reviewed: false,
  notify_report_posted: false,
  notify_event_reminders: false,
});

/** Reads an account_settings row defensively: anything but `true` is off. */
export function parseAccountSettings(row: unknown): AccountSettings {
  const obj = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  const settings = { ...DEFAULT_ACCOUNT_SETTINGS };
  for (const column of ACCOUNT_SETTING_COLUMNS) settings[column] = obj[column] === true;
  return settings;
}

/** The checkboxes as the form posted them: a ticked box is present, an unticked one is absent. */
export function settingsFromForm(form: { get(name: string): unknown }): AccountSettings {
  const settings = { ...DEFAULT_ACCOUNT_SETTINGS };
  for (const column of ACCOUNT_SETTING_COLUMNS) settings[column] = form.get(column) !== null;
  return settings;
}

function restHeaders(env: SupabaseEnv, accessToken: string): Record<string, string> {
  return { apikey: env.anonKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
}

/** Fetch for the settings calls: a network failure or error status logs the action and throws UNKNOWN. */
async function settingsRequest(action: string, url: string, init: RequestInit): Promise<Response> {
  let res: Response | null = null;
  try {
    res = await fetch(url, init);
  } catch {
    // Handled below with the error statuses.
  }
  if (!res || !res.ok) {
    logFailure(action, 'UNKNOWN');
    throw new DriverAccountError({ code: 'UNKNOWN', field: null, detail: `${action} failed` });
  }
  return res;
}

/** The signed-in account's settings; with no row yet, every choice is off. */
export async function getMySettings(
  env: SupabaseEnv,
  accessToken: string,
  userId: string,
): Promise<AccountSettings> {
  const select = ACCOUNT_SETTING_COLUMNS.join(',');
  const res = await settingsRequest(
    'get-settings',
    `${env.url}/rest/v1/account_settings?profile_id=eq.${encodeURIComponent(userId)}&select=${select}`,
    { headers: restHeaders(env, accessToken) },
  );
  const rows = (await res.json()) as unknown[];
  return Array.isArray(rows) && rows[0] ? parseAccountSettings(rows[0]) : { ...DEFAULT_ACCOUNT_SETTINGS };
}

/**
 * Saves the signed-in account's five choices as one upsert on its own row. `userId` must be the session's
 * user id, never a value from the form; RLS refuses any other row anyway (NFR1.2).
 */
export async function saveMySettings(
  env: SupabaseEnv,
  accessToken: string,
  userId: string,
  settings: AccountSettings,
): Promise<void> {
  const body: Record<string, unknown> = { profile_id: userId };
  for (const column of ACCOUNT_SETTING_COLUMNS) body[column] = settings[column] === true;
  await settingsRequest('save-settings', `${env.url}/rest/v1/account_settings?on_conflict=profile_id`, {
    method: 'POST',
    headers: { ...restHeaders(env, accessToken), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(body),
  });
}

/** Takes the account's one email action for this minute (claim_email_action); throws RATE_LIMITED when used. */
export async function claimEmailAction(env: SupabaseEnv, accessToken: string): Promise<void> {
  await userRpc<unknown>(env, accessToken, 'claim_email_action', {});
}

// --- Saving the profile (Save Profile: photo, bio and the five choices; BR4.3, NFR4.1-NFR4.3) ------

export type SaveProfileStep = 'settings' | 'photo' | 'profile';

export interface SaveProfileInput {
  userId: string;
  driverId: string;
  bio: string | null;
  photo: File | null;
  /** Null when the page could not load the saved choices, so saving must not overwrite them. */
  settings: AccountSettings | null;
}

export type SaveProfileResult = { ok: true } | { ok: false; step: SaveProfileStep; message: string };

const PICK_PHOTO_AGAIN = 'Pick your photo again and save.';

/** What a failed save says: what was and wasn't saved, and to pick the photo again when one was chosen. */
export function saveFailureMessage(
  step: SaveProfileStep,
  photoPicked: boolean,
  settingsSaved: boolean,
): string {
  const next = photoPicked ? PICK_PHOTO_AGAIN : 'Try again.';
  if (step === 'settings') return `Couldn't save your settings. ${next}`;
  if (settingsSaved) return `Your settings were saved, but your photo and bio weren't. ${next}`;
  return `Couldn't save your photo and bio. ${next}`;
}

/**
 * Saves in a retry-safe order: the settings upsert (idempotent), then the photo upload when one was picked,
 * then the bio and photo URL through update_my_driver_profile. A photo uploaded before a failed profile
 * update is deleted again (best effort), so retries leave no stray files.
 */
export async function saveProfile(
  env: SupabaseEnv,
  accessToken: string,
  input: SaveProfileInput,
): Promise<SaveProfileResult> {
  const photoPicked = input.photo !== null;
  const settingsSaved = input.settings !== null;
  const fail = (step: SaveProfileStep): SaveProfileResult => {
    console.error('save-profile failed', step.toUpperCase());
    return { ok: false, step, message: saveFailureMessage(step, photoPicked, settingsSaved) };
  };

  if (input.settings) {
    try {
      await saveMySettings(env, accessToken, input.userId, input.settings);
    } catch {
      return fail('settings');
    }
  }

  let photoUrl: string | undefined;
  if (input.photo) {
    try {
      photoUrl = await uploadDriverAvatar(env, accessToken, input.driverId, input.photo);
    } catch {
      return fail('photo');
    }
  }

  try {
    await updateMyDriverProfile(env, accessToken, { bio: input.bio, photoUrl });
  } catch {
    if (photoUrl) {
      await deleteDriverAvatar(env, accessToken, input.driverId, photoUrl).catch(() => {
        console.warn('delete-avatar failed', 'UNKNOWN');
      });
    }
    return fail('profile');
  }
  return { ok: true };
}

export interface ProfileFormValues {
  bio: string;
  /** Null when the form says the saved choices were not loaded (no `settings_loaded` field). */
  settings: AccountSettings | null;
}

export type ShapedProfile =
  | { ok: true; bio: string | null; photo: File | null; values: ProfileFormValues }
  | { ok: false; message: string; values: ProfileFormValues };

export const PROFILE_VALIDATION_MESSAGES = {
  bioTooLong: `Your bio can be at most ${DRIVER_BIO_MAX} characters.`,
  photoType: 'Profile photos must be PNG, JPG or WebP images. Pick another photo and save.',
  photoSize: `Profile photos can be at most ${DRIVER_AVATAR_MAX_BYTES / 1024 / 1024} MB. Pick another photo and save.`,
} as const;

/** Shapes the Save Profile form: the same bio and photo checks as before, plus the five choices. */
export function shapeProfileForm(form: { get(name: string): unknown }): ShapedProfile {
  const rawBio = form.get('bio');
  const bio = (typeof rawBio === 'string' ? rawBio : '').trim();
  const values: ProfileFormValues = {
    bio,
    settings: form.get('settings_loaded') !== null ? settingsFromForm(form) : null,
  };
  if (bio.length > DRIVER_BIO_MAX) {
    return { ok: false, message: PROFILE_VALIDATION_MESSAGES.bioTooLong, values };
  }

  const rawPhoto = form.get('photo');
  const photo = rawPhoto instanceof File && rawPhoto.size > 0 ? rawPhoto : null;
  if (photo && !DRIVER_AVATAR_TYPES[photo.type]) {
    return { ok: false, message: PROFILE_VALIDATION_MESSAGES.photoType, values };
  }
  if (photo && photo.size > DRIVER_AVATAR_MAX_BYTES) {
    return { ok: false, message: PROFILE_VALIDATION_MESSAGES.photoSize, values };
  }
  return { ok: true, bio: bio || null, photo, values };
}

// --- In-place email actions (contract C4; BR5.3, BR5.4, BR6.2) ---------------------------------

/** C4's JSON answer to an in-place action. */
export interface InPlaceResult {
  ok: boolean;
  message: string;
  field?: string;
  /** For example the updated incident row (U5). */
  data?: Record<string, unknown>;
}

export type EmailChangeStatus = 'sent' | 'INVALID' | 'SAME' | 'EMAIL_IN_USE' | 'RATE_LIMITED' | 'UNKNOWN';
export type PasswordResetStatus = 'sent' | 'NO_EMAIL' | 'RATE_LIMITED' | 'UNKNOWN';

const RATE_LIMITED_MESSAGE = 'Too many requests. Try again in a minute.';
const SEND_FAILED_MESSAGE = "Couldn't send the email. Try again.";

/** The message for an email change; with `address` (JSON answers only) the success names the new address. */
export function emailChangeMessage(status: EmailChangeStatus, address?: string): InPlaceResult {
  switch (status) {
    case 'sent':
      return {
        ok: true,
        message: `We sent a confirmation link to ${address ?? 'your new address'}. Your email changes once you click it (if a link also arrives at your current address, click that one too).`,
      };
    case 'INVALID':
      return { ok: false, message: 'Enter a valid email address.', field: 'new_email' };
    case 'SAME':
      return { ok: false, message: "That's already your email.", field: 'new_email' };
    case 'EMAIL_IN_USE':
      return { ok: false, message: 'That email is already used by another account.', field: 'new_email' };
    case 'RATE_LIMITED':
      return { ok: false, message: RATE_LIMITED_MESSAGE };
    default:
      return { ok: false, message: SEND_FAILED_MESSAGE };
  }
}

export function passwordResetMessage(status: PasswordResetStatus, address?: string): InPlaceResult {
  switch (status) {
    case 'sent':
      return { ok: true, message: `We sent a password reset link to ${address ?? 'your email address'}.` };
    case 'NO_EMAIL':
      return { ok: false, message: 'This account has no email address to send a reset link to.' };
    case 'RATE_LIMITED':
      return { ok: false, message: RATE_LIMITED_MESSAGE };
    default:
      return { ok: false, message: SEND_FAILED_MESSAGE };
  }
}

/** The account's one email action for this minute, as a status: null when it may go ahead. */
async function claimStatus(
  env: SupabaseEnv,
  accessToken: string,
): Promise<'RATE_LIMITED' | 'UNKNOWN' | null> {
  try {
    await claimEmailAction(env, accessToken);
    return null;
  } catch (err) {
    return errorCodeOf(err) === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'UNKNOWN';
  }
}

export interface OwnerSession {
  accessToken: string;
  user: AuthUser;
}

/** Validates the new address, takes the minute's email action, then asks Supabase Auth to send the link. */
export async function requestEmailChange(
  env: SupabaseEnv,
  session: OwnerSession,
  rawEmail: unknown,
  redirectTo: string,
): Promise<{ status: EmailChangeStatus; email: string | null }> {
  const email = normaliseEmail(rawEmail);
  if (!email) return { status: 'INVALID', email: null };
  if (email === session.user.email?.trim().toLowerCase()) return { status: 'SAME', email };
  const limited = await claimStatus(env, session.accessToken);
  if (limited) return { status: limited, email };
  const result = await changeEmail(env, session.accessToken, email, redirectTo);
  return { status: result.ok ? 'sent' : result.code, email };
}

/** Sends the recovery email to the account's own address (never a typed one), after the minute's claim. */
export async function requestOwnPasswordReset(
  env: SupabaseEnv,
  session: OwnerSession,
  redirectTo: string,
): Promise<PasswordResetStatus> {
  const email = session.user.email;
  if (!email) return 'NO_EMAIL';
  const limited = await claimStatus(env, session.accessToken);
  if (limited) return limited;
  try {
    await requestPasswordReset(env, email, redirectTo);
  } catch (err) {
    const status = err instanceof AuthRequestError && err.status === 429 ? 'RATE_LIMITED' : 'UNKNOWN';
    console.error('reset-password failed', status);
    return status;
  }
  console.info('reset-password sent', new URL(redirectTo).host);
  return 'sent';
}

// --- The own-profile controller (drivers/[id].astro; NFR1.3, NFR4.2) ----------------------------

export const PROFILE_INTENTS = [
  'save-profile',
  'change-email',
  'reset-password',
  ...INCIDENT_PROFILE_INTENTS,
] as const;
export type ProfileIntent = (typeof PROFILE_INTENTS)[number];

/**
 * The intent of a profile post. The form's hidden field says save-profile; an in-place button's own
 * `intent` (posted only when that button submits the form) wins over it. No intent at all is a save.
 */
export function resolveProfileIntent(values: unknown[]): ProfileIntent | null {
  const known = values.filter((v): v is ProfileIntent => (PROFILE_INTENTS as readonly unknown[]).includes(v));
  if (values.length > 0 && known.length === 0) return null;
  return known.find((v) => v !== 'save-profile') ?? 'save-profile';
}

function isIncidentIntent(intent: ProfileIntent): intent is IncidentProfileIntent {
  return (INCIDENT_PROFILE_INTENTS as readonly string[]).includes(intent);
}

/** True when the request asks for C4's JSON answer instead of a redirect. */
export function wantsJson(accept: string | null): boolean {
  return /\bapplication\/json\b/i.test(accept ?? '');
}

export interface ProfileEditingState {
  bio: string;
  settings: AccountSettings | null;
  error: string;
}

export type ProfilePostOutcome =
  | { kind: 'redirect'; location: string }
  | { kind: 'json'; status: number; body: InPlaceResult }
  | { kind: 'render'; status: number; editing: ProfileEditingState };

export interface ProfilePostContext {
  env: SupabaseEnv;
  session: OwnerSession | null;
  isOwner: boolean;
  driverId: string;
  /** The site's origin, for the email links' redirect targets. */
  origin: string;
  json: boolean;
  form: { get(name: string): unknown; getAll(name: string): unknown[] };
}

/** The status query a no-JavaScript in-place post redirects with (codes only, never an address). */
export const IN_PLACE_STATUS_PARAMS = {
  'change-email': 'email_status',
  'reset-password': 'reset_status',
} as const;

/** Handles a post to the own profile: only the owner may write; saves re-render on failure, actions answer in place. */
export async function handleProfilePost(ctx: ProfilePostContext): Promise<ProfilePostOutcome> {
  const profilePath = `/drivers/${encodeURIComponent(ctx.driverId)}`;
  if (!ctx.isOwner || !ctx.session) {
    return ctx.json
      ? {
          kind: 'json',
          status: 403,
          body: { ok: false, message: 'Only the driver can change this profile.' },
        }
      : { kind: 'redirect', location: profilePath };
  }
  const intent = resolveProfileIntent(ctx.form.getAll('intent'));
  if (!intent) return { kind: 'redirect', location: profilePath };
  if (intent === 'save-profile') return saveProfileOutcome(ctx, ctx.session, profilePath);
  if (isIncidentIntent(intent)) {
    const done = await handleIncidentProfileIntent(intent, ctx.env, ctx.session, ctx.form);
    if (ctx.json) {
      const body: InPlaceResult = {
        ok: done.ok,
        message: done.message,
        ...(done.data ? { data: done.data } : {}),
      };
      return { kind: 'json', status: done.status, body };
    }
    return {
      kind: 'redirect',
      location: `${profilePath}?edit=1&tab=incidents&${INCIDENT_STATUS_PARAM}=${encodeURIComponent(done.code)}`,
    };
  }

  let result: InPlaceResult;
  let status: string;
  if (intent === 'change-email') {
    const change = await requestEmailChange(
      ctx.env,
      ctx.session,
      ctx.form.get('new_email'),
      `${ctx.origin}${profilePath}`,
    );
    status = change.status;
    result = emailChangeMessage(change.status, change.email ?? undefined);
  } else {
    status = await requestOwnPasswordReset(ctx.env, ctx.session, `${ctx.origin}/reset-password`);
    result = passwordResetMessage(status as PasswordResetStatus, ctx.session.user.email ?? undefined);
  }
  if (ctx.json) {
    return { kind: 'json', status: result.ok ? 200 : status === 'RATE_LIMITED' ? 429 : 400, body: result };
  }
  return { kind: 'redirect', location: `${profilePath}?edit=1&${IN_PLACE_STATUS_PARAMS[intent]}=${status}` };
}

async function saveProfileOutcome(
  ctx: ProfilePostContext,
  session: OwnerSession,
  profilePath: string,
): Promise<ProfilePostOutcome> {
  const shaped = shapeProfileForm(ctx.form);
  if (!shaped.ok) {
    return { kind: 'render', status: 400, editing: { ...shaped.values, error: shaped.message } };
  }
  const saved = await saveProfile(ctx.env, session.accessToken, {
    userId: session.user.id,
    driverId: ctx.driverId,
    bio: shaped.bio,
    photo: shaped.photo,
    settings: shaped.values.settings,
  });
  if (!saved.ok) return { kind: 'render', status: 502, editing: { ...shaped.values, error: saved.message } };
  return { kind: 'redirect', location: `${profilePath}?saved=1` };
}

/** The no-JavaScript fallback's message for a status query value, or null for none or an unknown one. */
export function inPlaceStatusMessage(
  intent: 'change-email' | 'reset-password',
  status: string | null,
): InPlaceResult | null {
  if (!status) return null;
  if (intent === 'change-email') {
    const known: EmailChangeStatus[] = ['sent', 'INVALID', 'SAME', 'EMAIL_IN_USE', 'RATE_LIMITED', 'UNKNOWN'];
    return known.includes(status as EmailChangeStatus)
      ? emailChangeMessage(status as EmailChangeStatus)
      : null;
  }
  const known: PasswordResetStatus[] = ['sent', 'NO_EMAIL', 'RATE_LIMITED', 'UNKNOWN'];
  return known.includes(status as PasswordResetStatus)
    ? passwordResetMessage(status as PasswordResetStatus)
    : null;
}

// --- The owner's render (NFR3.1, NFR1.6) ----------------------------------------------------------

export interface OwnerProfileData {
  settings: AccountSettings;
  /** False when the saved choices could not be read; the page then shows a notice and Save keeps them. */
  settingsLoaded: boolean;
  email: string | null;
  /** The address an email change is waiting on, if any. */
  pendingEmail: string | null;
}

/**
 * The owner-only data for the editing tabs: the settings row, plus the pending email. The middleware's
 * getUser already carries `newEmail`; only a session that came from a token refresh lacks it, and then
 * the auth user is read once more.
 */
export async function loadOwnerProfile(env: SupabaseEnv, session: OwnerSession): Promise<OwnerProfileData> {
  const freshUser: Promise<AuthUser | null> =
    session.user.newEmail !== undefined
      ? Promise.resolve(session.user)
      : getUser(env, session.accessToken).catch(() => null);
  const [settings, user] = await Promise.all([
    getMySettings(env, session.accessToken, session.user.id).then(
      (value) => ({ value, loaded: true }),
      () => ({ value: { ...DEFAULT_ACCOUNT_SETTINGS }, loaded: false }),
    ),
    freshUser,
  ]);
  return {
    settings: settings.value,
    settingsLoaded: settings.loaded,
    email: user?.email ?? session.user.email,
    pendingEmail: user?.newEmail ?? null,
  };
}
