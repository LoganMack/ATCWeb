/**
 * The polls screens (polls S1-S4; BR3.3, BR5.1, FR1.8): the tool is a Staff-restricted area with full-Admin
 * pages and a dashboard card, the editor script loads only on the editor pages, the shared view renders no
 * submit control, and the public page reads through getPostedPoll.
 */
import { describe, expect, it } from 'vitest';
import { adminToolsFor, isStaffRestrictedPath, STAFF_RESTRICTED_PREFIXES } from '../../src/lib/auth';

const raw = (files: Record<string, unknown>) => files as Record<string, string>;
const SRC = raw(import.meta.glob('/src/**/*.{astro,ts}', { query: '?raw', import: 'default', eager: true }));

const LIST = SRC['/src/pages/admin/polls/index.astro'];
const NEW = SRC['/src/pages/admin/polls/new.astro'];
const EDIT = SRC['/src/pages/admin/polls/[id].astro'];
const PUBLIC = SRC['/src/pages/polls/[id].astro'];
const DASHBOARD = SRC['/src/pages/admin/fragment.astro'];
const VIEW = SRC['/src/lib/polls/view.ts'];

describe('Staff and the Polls tool (BR5.1)', () => {
  it('makes /admin/polls and everything under it a Staff-restricted path', () => {
    expect(STAFF_RESTRICTED_PREFIXES).toContain('/admin/polls');
    expect(isStaffRestrictedPath('/admin/polls')).toBe(true);
    expect(isStaffRestrictedPath('/admin/polls/new')).toBe(true);
    expect(isStaffRestrictedPath('/Admin/Polls/%61bc')).toBe(true);
    expect(isStaffRestrictedPath('/polls/abc')).toBe(false);
  });

  it('guards every admin poll page with requireFullAdmin', () => {
    for (const page of [LIST, NEW, EDIT]) {
      expect(page).toMatch(
        /const admin = requireFullAdmin\(Astro\);\s*if \(admin instanceof Response\) return admin;/,
      );
      expect(page).not.toMatch(/\brequireAdmin\(/);
    }
  });

  it('writes only through src/lib and logs every write', () => {
    for (const page of [LIST, NEW, EDIT]) {
      expect(page).not.toMatch(/fetch\(|\/rest\/v1|\/storage\/v1/);
      expect(page.match(/await Astro\.request\.formData\(\)/g)).toHaveLength(1);
      expect(page).toMatch(/name="intent"|String\(data\.get\('intent'\)/);
      expect(page).toContain('await logActivity(');
      expect(page).toContain("entity_type: 'poll'");
    }
    expect(LIST).toContain(
      "data-confirm={`${p.status === 'posted' ? 'Unpost' : 'Post'} the poll \"${p.title}\"?`}",
    );
    expect(LIST).toContain('data-confirm={`Delete the poll "${p.title}" with its images?');
  });
});

describe('the Admin Tools card (S1)', () => {
  it('lists Polls with a draft count and an icon, hidden from Staff', () => {
    const tools = DASHBOARD.slice(DASHBOARD.indexOf('const allTools'), DASHBOARD.indexOf('const tools ='));
    expect(tools).toContain("{ href: '/admin/polls', label: 'Polls', detail: `${pollDraftCount} draft");
    expect(DASHBOARD).toMatch(/\n {2}Polls: \['M3 13\.125/);
    expect(DASHBOARD).toMatch(/isFullAdmin\(admin\.profile\)\s*\?\s*countDraftPolls\(/);
    const cards = [
      { href: '/admin/polls', label: 'Polls' },
      { href: '/admin/news', label: 'News' },
    ];
    expect(adminToolsFor(cards, { role: 'staff' }).map((c) => c.label)).toEqual(['News']);
    expect(adminToolsFor(cards, { role: 'admin' }).map((c) => c.label)).toEqual(['Polls', 'News']);
  });
});

describe('the editor script (S3)', () => {
  it('is imported by the two editor pages and nothing else', () => {
    const importers = Object.keys(SRC).filter((path) =>
      /import ['"](?:\.\.\/)+scripts\/pollEditor['"]/.test(SRC[path]),
    );
    expect(importers.sort()).toEqual([
      '/src/pages/admin/polls/[id].astro',
      '/src/pages/admin/polls/new.astro',
    ]);
    for (const page of [NEW, EDIT]) expect(page).toContain('<PollEditor ');
  });

  it('posts one multipart form that the client router leaves alone', () => {
    const editor = SRC['/src/components/PollEditor.astro'];
    expect(editor).toMatch(
      /<form\s[^>]*method="POST"[^>]*data-astro-reload[^>]*enctype="multipart\/form-data"/,
    );
    expect(editor).toContain('name="updated_at"');
    expect(editor).toContain('name="structure"');
    for (const button of editor.match(/<button[^>]*>/g) ?? []) expect(button).toMatch(/class="btn btn-/);
    expect(editor).toContain('data-poll-size-message');
  });

  it('refuses an oversized save before parsing the body', () => {
    for (const page of [NEW, EDIT]) {
      const check = page.indexOf("pollSaveSizeError(Astro.request.headers.get('content-length'))");
      expect(check).toBeGreaterThan(-1);
      expect(check).toBeLessThan(page.indexOf('await Astro.request.formData()'));
      expect(page).toMatch(
        /Astro\.request\.method === 'POST' && !tooLarge\) \{\s*const data = await Astro\.request\.formData\(\);/,
      );
    }
  });

  it('shrinks chosen images and checks their total before submitting', () => {
    const script = SRC['/src/scripts/pollEditor.ts'];
    expect(script).toContain('shrinkPollImage(chosen)');
    expect(script).toContain('pollImagesBudgetMessage(');
    expect(script).toContain('await Promise.all(waiting)');
  });
});

describe('the shared view and the public page (FR1.8, BR3.3)', () => {
  it('renders no submit control and disables every input', () => {
    expect(VIEW).not.toMatch(/<form|<button|type="submit"/);
    for (const input of VIEW.match(/<input [^`]*?>/g) ?? []) expect(input).toContain('disabled');
  });

  it('reads the public poll through getPostedPoll and draws it with pollViewHtml', () => {
    expect(PUBLIC).toMatch(/await getPostedPoll\(supabaseEnv, pollId\)/);
    expect(PUBLIC).toContain('pollViewHtml(pollToView(');
    expect(PUBLIC).toContain('Astro.response.status = loadFailed ? 503 : 404;');
    expect(PUBLIC).toContain("Astro.response.headers.set('Cache-Control', 'public, s-maxage=30');");
    expect(PUBLIC).not.toContain('stale-while-revalidate');
    expect(PUBLIC).not.toMatch(/getPollForEdit|restGet|fetch\(/);
    const lib = SRC['/src/lib/db/polls.ts'];
    const posted = lib.slice(lib.indexOf('export async function getPostedPoll'));
    expect(posted.slice(0, posted.indexOf('\n}'))).toContain('&status=eq.posted&');
  });
});
