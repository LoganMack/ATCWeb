/**
 * The Admin > Email template editor (FR2.1, FR2.4, FR2.5): the dashboard shell handles both form intents with
 * one formData() read and redirects, each form carries its hidden intent, and the browser preview never pulls
 * in the database client.
 */
import { describe, expect, it } from 'vitest';

const SRC = import.meta.glob('/src/**/*.{astro,ts}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const shell = SRC['/src/pages/admin/index.astro'];
const fragment = SRC['/src/pages/admin/fragment.astro'];
const preview = SRC['/src/scripts/emailTemplatePreview.ts'];

describe('the admin dashboard controller', () => {
  it('handles the save and reset intents behind requireAdmin with one formData() read and a redirect', () => {
    expect(shell).toContain('requireAdmin(Astro)');
    expect(shell.match(/formData\(\)/g)).toHaveLength(1);
    expect(shell).toContain("intent === 'save-email-template'");
    expect(shell).toContain("intent === 'reset-email-template'");
    expect(shell).toMatch(/handleEmailTemplateForm\(/);
    expect(shell).toMatch(/Astro\.redirect\(`\/admin\$\{query\}`, 303\)/);
    expect(shell.indexOf('requireAdmin(Astro)')).toBeLessThan(shell.indexOf('formData()'));
  });

  it('writes only through src/lib, never calling Supabase from the page', () => {
    for (const page of [shell, fragment]) {
      expect(page).not.toMatch(/fetch\(\s*[`'"][^`'"]*\/rest\/v1/);
      expect(page).not.toContain('email_templates?');
    }
  });
});

describe('the template forms', () => {
  it('post to /admin with a hidden intent and kind on each form', () => {
    const forms = [...fragment.matchAll(/<form method="POST" action="\/admin"[\s\S]*?<\/form>/g)].map(
      (m) => m[0],
    );
    expect(forms).toHaveLength(2);
    expect(forms[0]).toContain('<input type="hidden" name="intent" value="save-email-template" />');
    expect(forms[1]).toContain('<input type="hidden" name="intent" value="reset-email-template" />');
    for (const form of forms) expect(form).toContain('<input type="hidden" name="kind" value={t.kind} />');
    for (const name of ['subject', 'lead', 'link_text']) expect(forms[0]).toContain(`name="${name}"`);
  });

  it('uses the shared button classes and the limits from the rules module', () => {
    expect(fragment).toContain('class="btn btn-primary btn-sm"');
    expect(fragment).toContain('class="btn btn-neutral btn-sm"');
    for (const field of ['subject', 'lead', 'link_text']) {
      expect(fragment).toContain(`maxlength={EMAIL_TEMPLATE_LIMITS.${field}.max}`);
    }
  });

  it('shows smaller analytics cards in four columns on wide screens', () => {
    expect(fragment).toContain('<dl class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">');
    expect(fragment).toContain('rounded-xl border border-white/10 bg-brand-ink p-4');
    expect(fragment).toContain('font-display text-xl leading-7');
  });

  it('builds the preview from the shared template rules without the database client', () => {
    expect(preview).toContain("from '../lib/notifications/templates'");
    expect(preview).not.toMatch(/db\/client|emailTemplates'/);
    expect(preview).toContain('textContent = text');
    expect(preview).not.toContain('innerHTML');
    expect(SRC['/src/lib/notifications/templates.ts']).not.toMatch(/from '\.\.\/db\//);
    expect(SRC['/src/lib/notifications/templateRules.ts']).not.toMatch(/^import /m);
  });
});
