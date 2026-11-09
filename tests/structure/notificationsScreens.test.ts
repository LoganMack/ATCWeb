/**
 * The in-site notifications screens and migration (notifications N1-N3; BR1.1, BR1.3, BR3.3, BR5.1): the
 * bell renders only behind myDriverId, between My Profile and the gear; each page script is imported by the
 * page or component that renders its hooks; the incident fragment URL ignores the deep-link parameters; the
 * nav fetches /api/nav-status once instead of /api/pending-signups, which still exists; and the migration
 * closes the table and functions to anon.
 */
import { describe, expect, it } from 'vitest';

const raw = (files: Record<string, unknown>) => files as Record<string, string>;
const SRC = raw(import.meta.glob('/src/**/*.{astro,ts}', { query: '?raw', import: 'default', eager: true }));
const SQL = raw(
  import.meta.glob(['/supabase/migrations/20261115120002_notifications.sql', '/supabase/down/20261115120002_notifications.down.sql'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
);

const NAV = SRC['/src/components/Nav.astro'];
const INCIDENTS = SRC['/src/pages/results/[subsessionId]/incidents.astro'];
const FRAGMENT = SRC['/src/pages/results/[subsessionId]/incidents/fragment.astro'];
const MIGRATION = SQL['/supabase/migrations/20261115120002_notifications.sql'];
const DOWN = SQL['/supabase/down/20261115120002_notifications.down.sql'];

const importers = (script: string) =>
  Object.keys(SRC).filter((path) => new RegExp(`import ['"](?:\\.\\.\\/)+scripts\\/${script}['"]`).test(SRC[path]));

describe('the nav bell (N1; BR1.1, BR1.3)', () => {
  it('renders the bell only for a driver-linked account, between My Profile and the gear', () => {
    const block = /\{myDriverId && \(([\s\S]*?)\n {6}\)\}/.exec(NAV);
    expect(block, 'the bell sits behind myDriverId').not.toBeNull();
    expect(block![1]).toContain('data-notifications-bell');
    expect(NAV.match(/data-notifications-bell(?=[\s>])/g)).toHaveLength(1);
    const profileAt = NAV.indexOf('data-profile-edit-toggle');
    const bellAt = NAV.indexOf('data-notifications-bell');
    const gearAt = NAV.indexOf('data-admin-gear');
    expect(profileAt).toBeLessThan(bellAt);
    expect(bellAt).toBeLessThan(gearAt);
  });

  it('is an icon-only .btn the gear’s size, with a hidden dot, a label and a dialog popup', () => {
    const bell = /<button\s([^>]*data-notifications-bell[^>]*)>([\s\S]*?)<\/button>/.exec(NAV);
    expect(bell).not.toBeNull();
    expect(bell![1]).toMatch(/class="btn btn-neutral relative !px-2\.5"/);
    expect(bell![1]).toContain('aria-label="Notifications"');
    expect(bell![1]).toContain('aria-haspopup="dialog"');
    expect(bell![2]).toMatch(/<svg[^>]*class="h-5 w-5"/);
    expect(bell![2]).toMatch(/data-notifications-dot\s+class="[^"]*\bhidden\b/);
    expect(NAV).toMatch(/<dialog\s[^>]*data-notifications-dialog/);
    expect(NAV).toMatch(/<button type="button" data-close-notifications class="btn btn-neutral/);
  });

  it('loads the bell script from the nav, which fetches /api/nav-status once per page', () => {
    expect(importers('notificationsBell')).toEqual(['/src/components/Nav.astro']);
    const script = SRC['/src/scripts/notificationsBell.ts'];
    expect(script.match(/fetch\('\/api\/nav-status'\)/g)).toHaveLength(1);
    expect(script).toContain('claimNavStatusFetch(document.documentElement, location.pathname + location.search)');
    expect(script).toContain("fetch('/api/notifications/open', { method: 'POST' })");
    expect(NAV).not.toContain('/api/pending-signups');
    expect(NAV).not.toContain('loadPendingSignups');
    // Kept for one release, unchanged.
    expect(SRC['/src/pages/api/pending-signups.ts']).toContain("'signup_requests?select=id&status=eq.pending'");
  });

  it('keeps the endpoints private and data access in src/lib', () => {
    for (const path of ['/src/pages/api/nav-status.ts', '/src/pages/api/notifications/open.ts']) {
      expect(SRC[path], path).toContain("'Cache-Control': 'private, no-store'");
      expect(SRC[path], path).not.toMatch(/fetch\(|\/rest\/v1/);
    }
    expect(SRC['/src/pages/api/notifications/open.ts']).toMatch(/export const POST: APIRoute/);
    expect(SRC['/src/pages/api/notifications/open.ts']).not.toMatch(/export const GET/);
  });
});

describe('the incident page deep links (N3; BR3.3, BR3.4)', () => {
  it('imports the opener in the incident page only, after the page’s own script', () => {
    expect(importers('incidentDeepLink')).toEqual(['/src/pages/results/[subsessionId]/incidents.astro']);
    const pageScript = INCIDENTS.indexOf("document.addEventListener('astro:page-load', initIncidentPage);");
    const opener = INCIDENTS.indexOf("import '../../../scripts/incidentDeepLink';");
    expect(pageScript).toBeGreaterThan(-1);
    expect(opener).toBeGreaterThan(pageScript);
  });

  it('builds the fragment URL without open and penalty, so they never enter its cache key', () => {
    expect(INCIDENTS).toContain("fragmentParams.delete('open');");
    expect(INCIDENTS).toContain("fragmentParams.delete('penalty');");
    const start = INCIDENTS.indexOf('const fragmentUrl =');
    expect(start).toBeGreaterThan(-1);
    const url = INCIDENTS.slice(start, INCIDENTS.indexOf(';', INCIDENTS.indexOf("''}`", start)));
    expect(url).not.toContain('Astro.url.search');
    expect(url).toContain('fragmentQuery');
  });

  it('gives the opener what it reads: the viewer’s own appeals and a notice above the list', () => {
    expect(FRAGMENT).toContain('appealedByMe: myAppealedPenaltyIds.has(p.id)');
    // Read in parallel with the map reads, and only when the viewer could appeal something (review R-03).
    expect(FRAGMENT).toMatch(/getRoundLayoutsForSubsessions\([^)]*\),\s*myAppealsRead,\s*\]\)/);
    expect(FRAGMENT).toMatch(/viewerSession && viewerMayAppeal\s*\?\s*getMyAppealedPenaltyIds/);
    expect(FRAGMENT).not.toContain('await getMyAppealedPenaltyIds');
    expect(FRAGMENT).toMatch(/<p\s+role="status"\s+hidden\s+data-incident-deeplink-notice/);
    expect(SRC['/src/lib/incidentAppeals.ts']).toContain('&submitter_id=eq.${encodeURIComponent(userId)}');
  });
});

describe('the migration (BR5.1)', () => {
  it('has a header comment and an expand-only body', () => {
    expect(MIGRATION.startsWith('-- In-site notifications')).toBe(true);
    expect(MIGRATION).toMatch(/Expand only/);
    expect(MIGRATION).not.toMatch(/\b(drop|alter table public\.(?!notifications))/i);
  });

  it('revokes the table and the site functions from anon and grants authenticated only what it needs', () => {
    expect(MIGRATION).toContain('revoke all on table public.notifications from public, anon, authenticated;');
    expect(MIGRATION).toContain('grant select on table public.notifications to authenticated;');
    expect(MIGRATION).not.toMatch(/grant (insert|update|delete|all)[^;]*public\.notifications/i);
    for (const fn of ['notification_unread_count', 'open_my_notifications']) {
      expect(MIGRATION).toContain(`revoke all on function public.${fn}() from public, anon;`);
      expect(MIGRATION).toContain(`grant execute on function public.${fn}() to authenticated;`);
    }
    for (const fn of ['notify_round_linked', 'notify_results_added', 'notify_report_posted', 'notify_appeal_closed', 'notify_schedule_vote']) {
      expect(MIGRATION).toContain(`revoke all on function private.${fn}() from public, anon, authenticated, service_role;`);
    }
    expect(MIGRATION.match(/security definer\s+set search_path = ''/g)?.length).toBe(8);
  });

  it('opens with one statement that marks only the rows it shows', () => {
    const body = MIGRATION.slice(MIGRATION.indexOf('create function public.open_my_notifications()'));
    expect(body).toMatch(/limit 50/);
    expect(body).toMatch(/and n\.id in \(select s\.id from shown s\)/);
    // unread_left is counted after the update, never from the listing's snapshot (review R-02).
    expect(body).not.toContain('unread_before');
    expect(body.indexOf("'unread_left'")).toBeGreaterThan(body.indexOf('into v_items'));
  });

  it('drops everything it created in the down script', () => {
    for (const name of [
      'polls_notify_schedule_vote',
      'incident_appeals_notify_closed',
      'round_incident_status_notify_posted',
      'curated_race_results_notify_results',
      'curated_rounds_notify_linked',
      'public.open_my_notifications()',
      'public.notification_unread_count()',
      'private.notify_round_participants(bigint, integer[])',
      'table public.notifications',
    ]) {
      expect(DOWN, name).toContain(name);
    }
    expect(DOWN.indexOf('drop table public.notifications')).toBeGreaterThan(DOWN.indexOf('drop trigger'));
  });
});
