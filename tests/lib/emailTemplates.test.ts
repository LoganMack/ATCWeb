/**
 * Edited email wording (FR2.1, FR2.2, FR2.5, FR2.7; BR2.2, BR2.3, BR2.6): validating what the admin typed, the
 * save and reset form handler with its redirect flash, and the PostgREST calls made with the admin's own
 * session. PostgREST is stubbed through fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMAIL_TEMPLATES_ANCHOR,
  TEMPLATE_SAVE_FAILED,
  getEmailTemplates,
  handleEmailTemplateForm,
  parseEmailTemplateFlash,
  toTemplateSet,
  validateTemplateInput,
  type EmailTemplateRow,
} from '../../src/lib/notifications/emailTemplates';
import { checkTemplateField, placeholdersIn } from '../../src/lib/notifications/templateRules';

const env = { url: 'https://project.example.test', anonKey: 'anon-key' };
const TOKEN = 'admin-token';

const input = (fields: Partial<Record<'kind' | 'subject' | 'lead' | 'link_text', unknown>>) => ({
  kind: 'report_posted',
  subject: '',
  lead: '',
  link_text: '',
  ...fields,
});

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [key, value] of Object.entries(fields)) f.set(key, value);
  return f;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('validateTemplateInput (BR2.2, BR2.3)', () => {
  it('trims each field and stores empty or whitespace-only fields as null (the default)', () => {
    expect(
      validateTemplateInput(input({ subject: '  Posted: {round}  ', lead: ' \n ', link_text: undefined })),
    ).toEqual({
      ok: true,
      kind: 'report_posted',
      text: { subject: 'Posted: {round}', lead: null, link_text: null },
    });
  });

  it('allows each limit exactly and refuses one character more, naming the field', () => {
    expect(
      validateTemplateInput(
        input({ subject: 's'.repeat(150), lead: 'l'.repeat(1000), link_text: 'k'.repeat(60) }),
      ).ok,
    ).toBe(true);
    expect(validateTemplateInput(input({ subject: 's'.repeat(151) }))).toMatchObject({
      ok: false,
      message: 'Subject: keep it to 150 characters.',
    });
    expect(validateTemplateInput(input({ lead: 'l'.repeat(1001) }))).toMatchObject({
      message: 'Message: keep it to 1000 characters.',
    });
    expect(validateTemplateInput(input({ link_text: 'k'.repeat(61) }))).toMatchObject({
      message: 'Link text: keep it to 60 characters.',
    });
  });

  it('allows line breaks in the message only, normalising Windows line ends', () => {
    expect(validateTemplateInput(input({ lead: 'One\r\nTwo' }))).toMatchObject({
      ok: true,
      text: { lead: 'One\nTwo' },
    });
    expect(validateTemplateInput(input({ subject: 'One\nTwo' }))).toMatchObject({
      message: "Subject: line breaks aren't allowed here.",
    });
    expect(validateTemplateInput(input({ link_text: 'One\rTwo' }))).toMatchObject({
      message: "Link text: line breaks aren't allowed here.",
    });
  });

  it("refuses a placeholder the email can't use, and treats other braces as plain text", () => {
    expect(validateTemplateInput(input({ subject: 'At {time}' }))).toMatchObject({
      ok: false,
      message: "Subject: {time} isn't a placeholder this email can use.",
      problem: { field: 'subject', reason: 'unknown_placeholder', placeholder: 'time' },
    });
    expect(validateTemplateInput(input({ kind: 'event_reminder', subject: '{event} {time} {day}' })).ok).toBe(
      true,
    );
    expect(validateTemplateInput(input({ lead: 'Smile { } and {not a placeholder} {round' })).ok).toBe(true);
    expect(placeholdersIn('{a} {b} {a} { c }')).toEqual(['a', 'b']);
  });

  it('refuses an unknown email kind', () => {
    expect(validateTemplateInput(input({ kind: 'newsletter' }))).toEqual({
      ok: false,
      message: 'Pick one of the three emails.',
      problem: null,
    });
    expect(checkTemplateField('report_posted', 'subject', null)).toBeNull();
  });
});

describe('handleEmailTemplateForm (FR2.1, FR2.5)', () => {
  it('saves with an upsert on kind as the signed-in account and flashes success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const query = await handleEmailTemplateForm(
      env,
      TOKEN,
      'save-email-template',
      form({ kind: 'report_posted', subject: ' Posted: {round} ', lead: '', link_text: 'Read it' }),
    );
    expect(query).toBe(`?email=saved&kind=report_posted#${EMAIL_TEMPLATES_ANCHOR}`);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://project.example.test/rest/v1/email_templates?on_conflict=kind');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers.Prefer).toContain('resolution=merge-duplicates');
    expect(JSON.parse(String(init.body))).toEqual({
      kind: 'report_posted',
      subject: 'Posted: {round}',
      lead: null,
      link_text: 'Read it',
    });
  });

  it('never writes an invalid template, and says which field and placeholder were wrong', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const query = await handleEmailTemplateForm(
      env,
      TOKEN,
      'save-email-template',
      form({ kind: 'appeal_reviewed', subject: 'Hi {driver}', lead: '', link_text: '' }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    const flash = parseEmailTemplateFlash(new URLSearchParams(query.split('#')[0]));
    expect(flash).toEqual({
      ok: false,
      kind: 'appeal_reviewed',
      message: `${TEMPLATE_SAVE_FAILED} Subject: {driver} isn't a placeholder this email can use.`,
    });
  });

  it('resets by deleting the row, and reports a refused write as a failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response('{"code":"42501"}', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await handleEmailTemplateForm(env, TOKEN, 'reset-email-template', form({ kind: 'event_reminder' })),
    ).toBe(`?email=reset&kind=event_reminder#${EMAIL_TEMPLATES_ANCHOR}`);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://project.example.test/rest/v1/email_templates?kind=eq.event_reminder');
    expect(init.method).toBe('DELETE');
    const failed = await handleEmailTemplateForm(
      env,
      TOKEN,
      'save-email-template',
      form({ kind: 'event_reminder', subject: 'Soon', lead: '', link_text: '' }),
    );
    expect(parseEmailTemplateFlash(new URLSearchParams(failed.split('#')[0]))).toEqual({
      ok: false,
      kind: 'event_reminder',
      message: 'Could not save the template.',
    });
  });

  it('refuses a reset of an unknown kind without calling the database', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const query = await handleEmailTemplateForm(env, TOKEN, 'reset-email-template', form({ kind: 'x' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(parseEmailTemplateFlash(new URLSearchParams(query.split('#')[0]))?.ok).toBe(false);
  });
});

describe('parseEmailTemplateFlash', () => {
  it('reads the success messages and ignores pages without a flash', () => {
    expect(parseEmailTemplateFlash(new URLSearchParams('email=saved&kind=report_posted'))?.message).toBe(
      'Saved the Incident Report Posted email.',
    );
    expect(parseEmailTemplateFlash(new URLSearchParams('email=reset&kind=event_reminder'))?.message).toBe(
      'Event Reminders is back to the default wording.',
    );
    expect(parseEmailTemplateFlash(new URLSearchParams(''))).toBeNull();
    expect(parseEmailTemplateFlash(new URLSearchParams('email=saved'))).toBeNull();
  });

  it('never echoes a tampered placeholder name', () => {
    const flash = parseEmailTemplateFlash(
      new URLSearchParams(
        'email=invalid&kind=report_posted&field=subject&reason=unknown_placeholder&ph=<script>',
      ),
    );
    expect(flash).toEqual({ ok: false, kind: 'report_posted', message: TEMPLATE_SAVE_FAILED });
  });
});

describe('reading templates', () => {
  it('reads with the admin session and keys the rows by kind', async () => {
    const rows: EmailTemplateRow[] = [
      { kind: 'report_posted', subject: 'S', lead: null, link_text: null, updated_at: 'x', updated_by: null },
    ];
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const read = await getEmailTemplates(env, TOKEN);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(toTemplateSet(read)).toEqual({ report_posted: { subject: 'S', lead: null, link_text: null } });
  });

  it('throws on an error so the page can say the templates are unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    await expect(getEmailTemplates(env, TOKEN)).rejects.toThrow(/500 on email_templates/);
  });
});
