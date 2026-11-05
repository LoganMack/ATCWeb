/**
 * The live preview beside each email template form in Admin > Email (FR2.4). The forms arrive in fragment HTML,
 * whose scripts never run, so one document-level input listener updates whichever form was typed in. The
 * preview uses the same rules as sending (previewTemplate), and writes text only, so typed markup shows as
 * typed rather than being run.
 */
import { previewTemplate } from '../lib/notifications/templates';
import { isEmailTemplateKind } from '../lib/notifications/templateRules';

/** The form fields and preview slots the updater reads and writes; tests pass small fakes. */
export interface PreviewForm {
  kind: string | undefined;
  field(name: 'subject' | 'lead' | 'link_text'): string | null;
  show(slot: 'subject' | 'lead' | 'link', text: string): void;
}

/** Fills one form's preview from what is typed in it now; does nothing for an unknown email. */
export function updatePreview(form: PreviewForm): void {
  if (!isEmailTemplateKind(form.kind)) return;
  const preview = previewTemplate(form.kind, {
    subject: form.field('subject'),
    lead: form.field('lead'),
    link_text: form.field('link_text'),
  });
  form.show('subject', preview.subject);
  form.show('lead', preview.lead);
  form.show('link', preview.linkText);
}

function domForm(form: HTMLFormElement): PreviewForm {
  const block = form.closest<HTMLElement>('[data-email-template]');
  return {
    kind: block?.dataset.emailTemplate,
    field: (name) => {
      const el = form.elements.namedItem(name);
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : null;
    },
    show: (slot, text) => {
      const el = block?.querySelector<HTMLElement>(`[data-preview-${slot}]`);
      if (el) el.textContent = text;
    },
  };
}

let bound = false;

/** Registers the listener once; it survives soft navigations and fragment reloads. */
export function bindEmailTemplatePreviews(): void {
  if (bound) return;
  bound = true;
  document.addEventListener('input', (event) => {
    const form = (event.target as Element | null)?.closest<HTMLFormElement>('form[data-email-template-form]');
    if (form) updatePreview(domForm(form));
  });
}
