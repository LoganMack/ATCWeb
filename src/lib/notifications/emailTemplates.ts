/**
 * Edited email wording in the admin panel's Email section (FR2; BR2.1-BR2.3, BR2.6): reading, validating,
 * saving and resetting the email_templates rows with the signed-in account's session, so Row Level Security
 * decides who may (Admin and Staff only). The scheduled sender reads the same rows with the service role
 * (run.ts). The pure rules live in templateRules.ts so the browser preview can use them too.
 */
import { writeHeaders, type SupabaseEnv } from '../db/client';
import { SETTING_NAMES, type EmailTemplateSet, type EmailTemplateText } from './templates';
import {
  EMAIL_TEMPLATE_FIELDS,
  EMAIL_TEMPLATE_LIMITS,
  checkTemplateField,
  isEmailTemplateKind,
  normalizeTemplateField,
  templateProblemMessage,
  type EmailTemplateField,
  type EmailTemplateKind,
  type TemplateFieldProblem,
} from './templateRules';

export {
  EMAIL_TEMPLATE_KINDS,
  EMAIL_TEMPLATE_LIMITS,
  PLACEHOLDERS_BY_KIND,
  type EmailTemplateKind,
} from './templateRules';

/** One stored row, as PostgREST returns it. */
export interface EmailTemplateRow extends EmailTemplateText {
  kind: EmailTemplateKind;
  updated_at: string;
  updated_by: string | null;
}

const SELECT = 'email_templates?select=kind,subject,lead,link_text,updated_at,updated_by';

export const UNKNOWN_KIND_MESSAGE = 'Pick one of the three emails.';
export const TEMPLATE_SAVE_FAILED = 'Could not save the template.';

export type TemplateInputResult =
  | { ok: true; kind: EmailTemplateKind; text: EmailTemplateText }
  | { ok: false; message: string; problem: TemplateFieldProblem | null };

/**
 * Shapes a submitted form into a row to save: trims each field (empty means the default, stored as null) and
 * checks lengths, line breaks and placeholders, naming the first problem.
 */
export function validateTemplateInput(input: {
  kind: unknown;
  subject: unknown;
  lead: unknown;
  link_text: unknown;
}): TemplateInputResult {
  if (!isEmailTemplateKind(input.kind)) return { ok: false, message: UNKNOWN_KIND_MESSAGE, problem: null };
  const kind = input.kind;
  const text: EmailTemplateText = {
    subject: normalizeTemplateField(input.subject),
    lead: normalizeTemplateField(input.lead),
    link_text: normalizeTemplateField(input.link_text),
  };
  for (const field of EMAIL_TEMPLATE_FIELDS) {
    const problem = checkTemplateField(kind, field, text[field]);
    if (problem) return { ok: false, message: templateProblemMessage(problem), problem };
  }
  return { ok: true, kind, text };
}

// --- The admin form (index.astro posts here; the dashboard fragment shows the outcome) --------------------

export const EMAIL_TEMPLATES_ANCHOR = 'email-templates';

/** What the dashboard shows after a save or reset. */
export interface EmailTemplateFlash {
  ok: boolean;
  kind: EmailTemplateKind | null;
  message: string;
}

const PLACEHOLDER_NAME = /^[A-Za-z0-9_]{1,40}$/;

function flashQuery(params: Record<string, string>): string {
  return `?${new URLSearchParams(params).toString()}#${EMAIL_TEMPLATES_ANCHOR}`;
}

/**
 * `save-email-template` and `reset-email-template`: validates, writes as the signed-in account and returns the
 * query string (with the anchor) for the redirect back to the dashboard. Never throws.
 */
export async function handleEmailTemplateForm(
  env: SupabaseEnv,
  accessToken: string,
  intent: string,
  form: FormData,
): Promise<string> {
  const kind = form.get('kind');
  if (intent === 'reset-email-template') {
    if (!isEmailTemplateKind(kind)) return flashQuery({ email: 'invalid' });
    try {
      await resetEmailTemplate(env, accessToken, kind);
      return flashQuery({ email: 'reset', kind });
    } catch (err) {
      console.error('Failed to reset the email template:', err);
      return flashQuery({ email: 'failed', kind });
    }
  }
  const checked = validateTemplateInput({
    kind,
    subject: form.get('subject'),
    lead: form.get('lead'),
    link_text: form.get('link_text'),
  });
  if (!checked.ok) {
    const params: Record<string, string> = { email: 'invalid' };
    if (isEmailTemplateKind(kind)) params.kind = kind;
    if (checked.problem) {
      params.field = checked.problem.field;
      params.reason = checked.problem.reason;
      if (checked.problem.reason === 'unknown_placeholder') params.ph = checked.problem.placeholder;
    }
    return flashQuery(params);
  }
  try {
    await saveEmailTemplate(env, accessToken, checked.kind, checked.text);
    return flashQuery({ email: 'saved', kind: checked.kind });
  } catch (err) {
    console.error('Failed to save the email template:', err);
    return flashQuery({ email: 'failed', kind: checked.kind });
  }
}

/** Reads the redirect's query back into a message, or null when there is none (or it was tampered with). */
export function parseEmailTemplateFlash(params: URLSearchParams): EmailTemplateFlash | null {
  const outcome = params.get('email');
  const rawKind = params.get('kind');
  const kind = isEmailTemplateKind(rawKind) ? rawKind : null;
  const name = kind ? SETTING_NAMES[kind] : 'The email';
  if (outcome === 'saved' && kind) return { ok: true, kind, message: `Saved the ${name} email.` };
  if (outcome === 'reset' && kind)
    return { ok: true, kind, message: `${name} is back to the default wording.` };
  if (outcome === 'failed') return { ok: false, kind, message: TEMPLATE_SAVE_FAILED };
  if (outcome !== 'invalid') return null;
  const field = params.get('field');
  const reason = params.get('reason');
  if (!kind || !(EMAIL_TEMPLATE_FIELDS as readonly string[]).includes(field ?? '')) {
    return { ok: false, kind, message: `${TEMPLATE_SAVE_FAILED} ${UNKNOWN_KIND_MESSAGE}` };
  }
  const typedField = field as EmailTemplateField;
  let problem: TemplateFieldProblem | null = null;
  if (reason === 'too_long') {
    problem = { field: typedField, reason, max: EMAIL_TEMPLATE_LIMITS[typedField].max };
  } else if (reason === 'line_break') {
    problem = { field: typedField, reason };
  } else if (reason === 'unknown_placeholder' && PLACEHOLDER_NAME.test(params.get('ph') ?? '')) {
    problem = { field: typedField, reason, placeholder: params.get('ph')! };
  }
  if (!problem) return { ok: false, kind, message: TEMPLATE_SAVE_FAILED };
  return { ok: false, kind, message: `${TEMPLATE_SAVE_FAILED} ${templateProblemMessage(problem)}` };
}

/** Rows keyed by kind; unknown kinds (none should exist) are left out. */
export function toTemplateSet(rows: EmailTemplateRow[]): EmailTemplateSet {
  const set: EmailTemplateSet = {};
  for (const row of rows) {
    if (isEmailTemplateKind(row.kind)) {
      set[row.kind] = { subject: row.subject, lead: row.lead, link_text: row.link_text };
    }
  }
  return set;
}

async function failure(res: Response, what: string): Promise<Error> {
  const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
  return new Error(`Supabase ${what} error ${res.status} on email_templates: ${body}`);
}

/** Every stored template, read as the signed-in account (Admin or Staff). Throws on any error. */
export async function getEmailTemplates(env: SupabaseEnv, accessToken: string): Promise<EmailTemplateRow[]> {
  const res = await fetch(`${env.url}/rest/v1/${SELECT}`, { headers: writeHeaders(env, accessToken) });
  if (!res.ok) throw await failure(res, 'read');
  return (await res.json()) as EmailTemplateRow[];
}

/** Saves all three fields of one email (an upsert on kind; last write wins). Throws on any error. */
export async function saveEmailTemplate(
  env: SupabaseEnv,
  accessToken: string,
  kind: EmailTemplateKind,
  text: EmailTemplateText,
): Promise<void> {
  const res = await fetch(`${env.url}/rest/v1/email_templates?on_conflict=kind`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ kind, subject: text.subject, lead: text.lead, link_text: text.link_text }),
  });
  if (!res.ok) throw await failure(res, 'save');
}

/** Deletes one email's row, so it goes back to the built-in wording. Throws on any error. */
export async function resetEmailTemplate(
  env: SupabaseEnv,
  accessToken: string,
  kind: EmailTemplateKind,
): Promise<void> {
  const res = await fetch(`${env.url}/rest/v1/email_templates?kind=eq.${encodeURIComponent(kind)}`, {
    method: 'DELETE',
    headers: writeHeaders(env, accessToken),
  });
  if (!res.ok) throw await failure(res, 'reset');
}
