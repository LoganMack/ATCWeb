/**
 * The rules for edited email wording (BR2.2, BR2.3): which placeholders each email may use, how long each
 * field may be and where line breaks are allowed. Pure, so the admin form handler, the browser preview and
 * the scheduled sender all apply the same checks. The database repeats the length and line-break checks
 * (email_templates); placeholders are checked here only.
 */

export type EmailTemplateKind = 'appeal_reviewed' | 'report_posted' | 'event_reminder';
export type EmailTemplateField = 'subject' | 'lead' | 'link_text';

export const EMAIL_TEMPLATE_KINDS: readonly EmailTemplateKind[] = [
  'appeal_reviewed',
  'report_posted',
  'event_reminder',
];
export const EMAIL_TEMPLATE_FIELDS: readonly EmailTemplateField[] = ['subject', 'lead', 'link_text'];

export const EMAIL_TEMPLATE_LIMITS: Record<EmailTemplateField, { max: number; multiline: boolean }> = {
  subject: { max: 150, multiline: false },
  lead: { max: 1000, multiline: true },
  link_text: { max: 60, multiline: false },
};

export const PLACEHOLDERS_BY_KIND: Record<EmailTemplateKind, readonly string[]> = {
  appeal_reviewed: ['round'],
  report_posted: ['round'],
  event_reminder: ['event', 'time', 'day'],
};

export const FIELD_LABELS: Record<EmailTemplateField, string> = {
  subject: 'Subject',
  lead: 'Message',
  link_text: 'Link text',
};

/** `{word}` is a placeholder; any other brace is plain text. */
export const PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_]+)\}/g;

export function isEmailTemplateKind(value: unknown): value is EmailTemplateKind {
  return typeof value === 'string' && (EMAIL_TEMPLATE_KINDS as readonly string[]).includes(value);
}

/** The placeholder names a text uses, in order of first use. */
export function placeholdersIn(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/** Trims a typed field (line breaks normalised to \n); empty or whitespace-only means "use the default" (null). */
export function normalizeTemplateField(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\r\n?/g, '\n').trim();
  return text === '' ? null : text;
}

export type TemplateFieldProblem =
  | { field: EmailTemplateField; reason: 'too_long'; max: number }
  | { field: EmailTemplateField; reason: 'line_break' }
  | { field: EmailTemplateField; reason: 'unknown_placeholder'; placeholder: string };

/** The first problem with one stored or typed field, or null when it may be used. Null text is always fine. */
export function checkTemplateField(
  kind: EmailTemplateKind,
  field: EmailTemplateField,
  text: string | null,
): TemplateFieldProblem | null {
  if (text === null) return null;
  const limit = EMAIL_TEMPLATE_LIMITS[field];
  if (text.length > limit.max) return { field, reason: 'too_long', max: limit.max };
  if (!limit.multiline && /[\r\n]/.test(text)) return { field, reason: 'line_break' };
  const allowed = PLACEHOLDERS_BY_KIND[kind];
  const unknown = placeholdersIn(text).find((name) => !allowed.includes(name));
  if (unknown !== undefined) return { field, reason: 'unknown_placeholder', placeholder: unknown };
  return null;
}

/** One sentence naming the field and what is wrong with it. */
export function templateProblemMessage(problem: TemplateFieldProblem): string {
  const label = FIELD_LABELS[problem.field];
  if (problem.reason === 'too_long') return `${label}: keep it to ${problem.max} characters.`;
  if (problem.reason === 'line_break') return `${label}: line breaks aren't allowed here.`;
  return `${label}: {${problem.placeholder}} isn't a placeholder this email can use.`;
}

/**
 * Fills a text's placeholders in one pass, so a value that itself contains "{time}" is never expanded again.
 * Null when the text names a placeholder with no value.
 */
export function fillPlaceholders(text: string, values: Record<string, string>): string | null {
  let missing = false;
  const filled = text.replace(PLACEHOLDER_PATTERN, (_whole, name: string) => {
    if (!Object.hasOwn(values, name)) {
      missing = true;
      return '';
    }
    return values[name];
  });
  return missing ? null : filled;
}
