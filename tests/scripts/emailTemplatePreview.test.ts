/**
 * The Admin > Email live preview (FR2.4): typed wording fills with the sample values, fields that would fall
 * back show the default, and an unknown email leaves the preview alone.
 */
import { describe, expect, it } from 'vitest';
import { updatePreview, type PreviewForm } from '../../src/scripts/emailTemplatePreview';
import { SAMPLE_PLACEHOLDER_VALUES } from '../../src/lib/notifications/templates';

function fakeForm(kind: string | undefined, fields: Record<string, string>) {
  const shown: Record<string, string> = {};
  const form: PreviewForm = {
    kind,
    field: (name) => fields[name] ?? null,
    show: (slot, text) => (shown[slot] = text),
  };
  return { form, shown };
}

describe('updatePreview', () => {
  it('shows the typed wording with sample values, as plain text', () => {
    const { form, shown } = fakeForm('report_posted', {
      subject: 'Posted: {round}',
      lead: 'Hi <b>all</b>\nthe {round} report is up',
      link_text: 'Read it',
    });
    updatePreview(form);
    expect(shown).toEqual({
      subject: `Posted: ${SAMPLE_PLACEHOLDER_VALUES.round}`,
      lead: `Hi <b>all</b>\nthe ${SAMPLE_PLACEHOLDER_VALUES.round} report is up`,
      link: 'Read it',
    });
  });

  it('shows the default for an empty field or one with a placeholder the email cannot use', () => {
    const { form, shown } = fakeForm('appeal_reviewed', { subject: '', lead: 'At {time}', link_text: '   ' });
    updatePreview(form);
    expect(shown.subject).toBe('Your appeal has been reviewed');
    expect(shown.lead).toContain(`your appeal for ${SAMPLE_PLACEHOLDER_VALUES.round}`);
    expect(shown.link).toBe('View the incidents');
  });

  it('does nothing for an unknown email', () => {
    const { form, shown } = fakeForm('newsletter', { subject: 'x' });
    updatePreview(form);
    expect(shown).toEqual({});
  });
});
