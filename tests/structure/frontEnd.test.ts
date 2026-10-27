/**
 * Front-end loading (U5: FR4, FR7, FR8): the layout loads only the site-wide scripts and each page imports
 * the feature scripts whose hooks it renders; the five shells preload their own fragment URL; fonts are
 * self-hosted; and no POST form opts back into the client router.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import HEADERS from '../../public/_headers?raw';

const raw = (files: Record<string, unknown>) => files as Record<string, string>;
const ASTRO = raw(import.meta.glob('/src/**/*.astro', { query: '?raw', import: 'default', eager: true }));
const SRC = raw(
  import.meta.glob('/src/**/*.{astro,ts,js,mjs,css}', { query: '?raw', import: 'default', eager: true }),
);
// A lazy glob is only used for its keys, which list the font files that exist.
const FONT_FILES = Object.keys(import.meta.glob('/public/fonts/*.woff2'));

const LAYOUT = ASTRO['/src/layouts/Layout.astro'];
// Vitest empties .css imports, even with ?raw, so the stylesheet is read from disk. The specifier is typed as
// a plain string because the project has no Node type definitions.
let GLOBAL_CSS = '';
beforeAll(async () => {
  const fs = await import('node:fs/promises' as string);
  GLOBAL_CSS = await fs.readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8');
});

const SITE_WIDE = [
  'pageProgress',
  'reveal',
  'hard-form-submit',
  'sortable-table',
  'expandRows',
  'theme',
  'delegatedControls',
];

const P = '/src/pages/';
/** Each moved script, the hook attributes it acts on, and the pages that must import it. */
const SCRIPT_MAP: Record<string, { hooks: string[]; shells: string[] }> = {
  localTime: {
    hooks: ['data-utc-time'],
    shells: ['briefing/[eventId].astro', 'index.astro', 'calendar.astro'],
  },
  circuitLayoutDetail: { hooks: ['data-layout-detail-body'], shells: ['circuits.astro'] },
  hofClassFilter: { hooks: ['data-hof-card'], shells: ['hall-of-fame.astro'] },
  addToCalendar: {
    hooks: ['data-ics-event', 'data-ics-download'],
    shells: ['calendar.astro', 'index.astro'],
  },
  lightbox: {
    hooks: ['data-lightbox'],
    shells: [
      'media.astro',
      'admin/champions/hall-of-fame/[driverId].astro',
      'admin/champions/[seasonId]/[classId].astro',
      'hall-of-fame.astro',
      'champions.astro',
    ],
  },
  tableCsvExport: { hooks: ['data-csv-export'], shells: ['standings.astro'] },
  driverPickerSearch: {
    hooks: ['data-driver-picker'],
    shells: [
      'results/[subsessionId]/incidents.astro',
      'results/[subsessionId].astro',
      'results/[subsessionId]/kudos.astro',
    ],
  },
  // U2 driver-linking: the linking page's search and confirm dialog.
  linkDriver: { hooks: ['data-link-driver'], shells: ['link-driver.astro'] },
  // U3 profile-settings: the own profile's editing tabs (NFR3.2).
  profileEditing: { hooks: ['data-profile-tabs'], shells: ['drivers/[id].astro'] },
  // U5 incident-management: the Incident Management tab's popups, and the Incident Submissions list's Add Comment.
  incidentManagement: {
    hooks: ['data-incident-management'],
    shells: ['drivers/[id].astro', 'results/[subsessionId]/incidents.astro'],
  },
  // U6 interviews: the Interviews tab's download, confirm popup and delete.
  interviews: { hooks: ['data-interviews-panel'], shells: ['drivers/[id].astro'] },
  // profile-liveries: the Liveries tab's uploads, downloads and popups.
  liveries: { hooks: ['data-liveries-panel'], shells: ['drivers/[id].astro'] },
  logoSelect: {
    hooks: ['data-logo-select'],
    shells: [
      'calendar.astro',
      'news/index.astro',
      'results.astro',
      'standings.astro',
      'teams.astro',
      'admin/awards/index.astro',
      'admin/events/index.astro',
      'admin/events/[id].astro',
      'admin/teams/[id].astro',
    ],
  },
};

const PRELOAD_SHELLS = [
  'index.astro',
  'standings.astro',
  'results/[subsessionId].astro',
  'results/[subsessionId]/incidents.astro',
  'drivers/[id].astro',
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when the file's markup carries the attribute (not a `[data-x]` selector in a script). */
function rendersHook(text: string, hook: string): boolean {
  return new RegExp(`\\b${escapeRe(hook)}(?=[\\s=>/])`).test(text);
}

/** Files that import the component at `path` (matched by its exact file name). */
function importersOf(path: string): string[] {
  const name = path.split('/').pop()!;
  const re = new RegExp(`from ['"][^'"]*/${escapeRe(name)}['"]`);
  return Object.keys(ASTRO).filter((file) => file !== path && re.test(ASTRO[file]));
}

/** The shell that loads a fragment route, found by its route string in a `data-fragment-url` page. */
function shellOf(fragment: string): string | undefined {
  const route = fragment
    .replace(/^\/src\/pages/, '')
    .replace(/\.astro$/, '')
    .split(/(\[[^\]]+\])/)
    .map((part) => (/^\[.+\]$/.test(part) ? '\\$\\{[^}]+\\}' : escapeRe(part)))
    .join('');
  const re = new RegExp(`['"\`]${route}(?:['"\`?]|\\$\\{)`);
  return Object.keys(ASTRO).find(
    (file) =>
      file.startsWith(P) &&
      !file.endsWith('/fragment.astro') &&
      /data-fragment-url/.test(ASTRO[file]) &&
      re.test(ASTRO[file]),
  );
}

/** Pages that must import a script for `hooks`: renderers, through components, up to fragment shells. */
function requiredShells(hooks: string[]): string[] {
  const pending = Object.keys(ASTRO).filter((file) => hooks.some((hook) => rendersHook(ASTRO[file], hook)));
  const seen = new Set<string>();
  const shells = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.startsWith(P)) pending.push(...importersOf(file));
    else if (file.endsWith('/fragment.astro')) shells.add(shellOf(file) ?? `no shell for ${file}`);
    else shells.add(file);
  }
  return [...shells].sort();
}

function importsScript(text: string, script: string): boolean {
  return new RegExp(`import ['"](?:\\.\\./)+scripts/${escapeRe(script)}['"]`).test(text);
}

describe('front-end loading (U5)', () => {
  it('loads exactly the 7 site-wide scripts from Layout.astro (BR2.1)', () => {
    const loaded = [...LAYOUT.matchAll(/<script src="\.\.\/scripts\/([\w-]+)\.ts"><\/script>/g)].map(
      (m) => m[1],
    );
    expect(loaded.sort()).toEqual([...SITE_WIDE].sort());
    for (const script of Object.keys(SCRIPT_MAP)) expect(LAYOUT, script).not.toContain(`scripts/${script}`);
  });

  it('imports each moved script in exactly the pages that render its hook (BR2.2)', () => {
    for (const [script, { hooks, shells }] of Object.entries(SCRIPT_MAP)) {
      const expected = shells.map((s) => P + s).sort();
      expect(requiredShells(hooks), `${script}: pages rendering ${hooks.join(', ')}`).toEqual(expected);
      const importers = Object.keys(SRC).filter((file) => importsScript(SRC[file], script));
      expect(importers.sort(), `${script}: importers`).toEqual(expected);
    }
    // The walk follows components into fragments: PhotoGrid reaches champions.astro through ChampionCard.
    expect(requiredShells(['data-lightbox'])).toContain(`${P}champions.astro`);
  });

  it('preloads each shell fragment with the same string the loader fetches (BR1.1, BR1.3)', () => {
    expect(LAYOUT).toMatch(
      /\{preloadFragment && <link rel="preload" as="fetch" crossorigin="anonymous" href=\{preloadFragment\} \/>\}/,
    );
    for (const shell of PRELOAD_SHELLS) {
      const text = ASTRO[P + shell];
      expect(text, shell).toMatch(/\nconst fragmentUrl =/);
      expect(text, shell).toMatch(/<Layout\b[^>]*\spreloadFragment=\{fragmentUrl\}/);
      expect(text, shell).toMatch(/data-fragment-url=\{fragmentUrl\}/);
      expect(text.match(/data-fragment-url=/g), shell).toHaveLength(1);
    }
    const preloading = Object.keys(ASTRO).filter((f) => /\spreloadFragment=/.test(ASTRO[f]));
    expect(preloading.sort()).toEqual(PRELOAD_SHELLS.map((s) => P + s).sort());
  });

  it('requests nothing from Google Fonts and preloads two self-hosted fonts (BR3.2, BR3.3)', () => {
    const hits = Object.keys(SRC).filter((f) => /fonts\.(googleapis|gstatic)\.com/.test(SRC[f]));
    expect(hits).toEqual([]);
    const preloads = [...LAYOUT.matchAll(/<link\s+rel="preload"\s+as="font"([^>]*)\/>/g)].map((m) => m[1]);
    expect(preloads).toHaveLength(2);
    for (const attrs of preloads) {
      expect(attrs).toMatch(/\stype="font\/woff2"\s+crossorigin\s+href="\/fonts\//);
      // Kept across client-side navigations, so the router never re-adds a preload the page has already used.
      expect(attrs).toMatch(/\sdata-astro-transition-persist="font-preload-\w+"/);
    }
    const hrefs = preloads.map((attrs) => /href="([^"]+)"/.exec(attrs)![1]);
    expect(hrefs).toEqual(['/fonts/teko-latin-v1.woff2', '/fonts/roboto-latin-v1.woff2']);
    for (const href of hrefs) expect(FONT_FILES).toContain(`/public${href}`);
  });

  it('declares every weight with font-display: swap from files that exist (BR3.1)', () => {
    const faces = [...GLOBAL_CSS.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
    const declared = new Set<string>();
    for (const face of faces) {
      expect(face).toMatch(/font-display:\s*swap;/);
      expect(face).toMatch(/unicode-range:\s*U\+/);
      const family = /font-family:\s*'(\w+)'/.exec(face)![1];
      const weight = /font-weight:\s*(\d+)/.exec(face)![1];
      const url = /src:\s*url\('([^']+)'\) format\('woff2'\)/.exec(face)![1];
      expect(FONT_FILES, url).toContain(`/public${url}`);
      const subset = /^\/fonts\/[a-z]+-([a-z-]+)-v\d+\.woff2$/.exec(url)![1];
      declared.add(`${family} ${weight} ${subset}`);
    }
    const expected = [
      ...['400', '500', '600', '700'].map((w) => `Teko ${w}`),
      ...['400', '500', '700'].map((w) => `Roboto ${w}`),
    ].flatMap((fw) => [`${fw} latin`, `${fw} latin-ext`]);
    // Roboto greek renders the Δ in table headers (Pos Δ, Pts Δ) as Google Fonts did.
    expected.push(...['400', '500', '700'].map((w) => `Roboto ${w} greek`));
    expect([...declared].sort()).toEqual(expected.sort());
    expect(faces).toHaveLength(expected.length);
    // Every file in public/fonts/ is used by some @font-face, so none ships unused.
    const referenced = new Set(faces.map((face) => `/public${/url\('([^']+)'\)/.exec(face)![1]}`));
    expect([...referenced].sort()).toEqual([...FONT_FILES].sort());
  });

  it('caches /fonts/* for a year as immutable (BR3.1)', () => {
    const block = /^\/fonts\/\*\r?\n((?:[ \t]+.*\r?\n?)+)/m.exec(HEADERS);
    expect(block).not.toBeNull();
    const cache = /Cache-Control:\s*(.+)/.exec(block![1])![1];
    expect(cache).toMatch(/\bpublic\b/);
    expect(cache).toMatch(/\bimmutable\b/);
    expect(Number(/max-age=(\d+)/.exec(cache)![1])).toBeGreaterThanOrEqual(31536000);
  });

  it('gives signed-out visitors the My Profile link, and moves Discord to the login page (U1: BR2.1, BR2.3, BR2.4)', () => {
    const nav = ASTRO['/src/components/Nav.astro'];
    const link = /<a href="\/my-profile"([^>]*)>/.exec(nav);
    expect(link, 'Nav links to /my-profile').not.toBeNull();
    expect(link![1]).toContain('aria-label="My Profile"');
    expect(link![1]).toContain('data-testid="nav-my-profile"');
    expect(link![1]).toMatch(/class="btn btn-primary !px-2\.5"/);
    // The signed-out button is gone, and the header reads nothing about the viewer to draw the link.
    expect(nav).not.toMatch(/>\s*Sign-Up\s*</);
    expect(nav).not.toContain('discordUrl');

    const login = ASTRO['/src/pages/login.astro'];
    expect(login).toMatch(
      /New to the league\?\s*<a\s+href=\{discordUrl\}\s+target="_blank"\s+rel="noopener noreferrer"/,
    );
    expect(login).toContain('resolveSiteLinks(Astro.locals)');
    expect(login).toContain('href="/signup"');
  });

  it('shows signed-in accounts without a driver a red dot on a "Link Driver" link (U2: BR3.1, NFR3.1; BR1.9)', () => {
    const nav = ASTRO['/src/components/Nav.astro'];
    // The Broadcaster has no driver to link, so no dot.
    expect(nav).toMatch(
      /const needsDriverLink = Boolean\(Astro\.locals\.session\) && !myDriverId && !isBroadcasterAccount\(Astro\.locals\);/,
    );
    const link =
      /<a href="\/my-profile"([^>]*data-testid="nav-my-profile-link-driver"[^>]*)>([\s\S]*?)<\/a>/.exec(nav);
    expect(link, 'Nav has the unlinked My Profile link').not.toBeNull();
    expect(link![1]).toContain('aria-label="Link Driver"');
    // The Broadcaster's link reads "Broadcaster" through myProfileLabel.
    expect(nav).toMatch(
      /<a href="\/my-profile"[^>]*aria-label=\{profileLabel\}[^>]*data-testid="nav-my-profile-broadcaster"/,
    );
    expect(link![1]).toMatch(/class="btn btn-primary relative !px-2\.5"/);
    const dot =
      /<span data-link-driver-dot class="([^"]+)" aria-hidden="true"><span class="([^"]+)"><\/span><\/span>/.exec(
        link![2],
      );
    expect(dot, 'the dot sits inside the link').not.toBeNull();
    // A pink dot on a canvas-coloured rim, placed like the admin gear's badge.
    expect(dot![1]).toMatch(/\babsolute -right-1 -top-1\b/);
    expect(dot![1]).toContain('bg-brand-ink');
    expect(dot![2]).toContain('bg-brand-pink');
    expect(dot![2]).toContain('rounded-full');
    // The signed-out link stays first and dot-free, so cached anonymous pages carry no viewer state.
    const signedOut = /<a href="\/my-profile"([^>]*)>([\s\S]*?)<\/a>/.exec(nav)!;
    expect(signedOut[1]).toContain('data-testid="nav-my-profile"');
    expect(signedOut[2]).not.toContain('data-link-driver-dot');
  });

  it('gives the linking page its dialogs, Broadcaster row and sign-up popup, with the shared buttons (U2: BR3.5; C6)', () => {
    const page = ASTRO['/src/pages/link-driver.astro'];
    // The warning lives in the confirmation popup only, no longer in a box on the page.
    expect(page).toContain(
      'This is a permanent action. Once linked, you must contact an admin to change linked drivers.',
    );
    expect(page).not.toContain('data-testid="link-driver-warning"');
    expect(page).not.toContain("Can't find your name?");
    expect(page).toMatch(/<dialog\s+data-link-driver-dialog/);
    expect(page).toMatch(/<dialog\s+id="link-driver-signup-dialog"\s+data-signup-dialog/);
    expect(page).toMatch(/name="intent" value="link-driver"/);
    expect(page).toMatch(/name="intent" value="request-driver"/);
    expect(page).toContain("intent === 'claim-broadcaster'");
    expect(page).toMatch(/data-testid="link-driver-row-link"/);
    expect(page).toMatch(/data-testid="link-driver-broadcaster-row"/);
    expect(page).toContain('set:html={safeJson(takenNumbers)}');
    expect(page).toContain('return Astro.redirect(`/login?next=${LINK_DRIVER_PATH}`, 302)');
    // Data access goes through src/lib only.
    expect(page).not.toMatch(/rest\/v1|fetch\(/);
    // Every button is a shared .btn, except the popups' ✕ close icons, styled as in ReportIncidentDialog.
    for (const button of page.match(/<button[^>]*>/g) ?? []) {
      if (/aria-label="Close"/.test(button)) continue;
      expect(button).toMatch(/class="btn btn-/);
    }
  });

  it('labels website requests and cancelled rows on Admin > Sign-ups (U2: BR3.13, BR3.14)', () => {
    const page = ASTRO['/src/pages/admin/signups/index.astro'];
    expect(page).toMatch(/r\.source === 'website' \? \(/);
    expect(page).toMatch(/Source: <span[^>]*>Website<\/span>/);
    expect(page).toMatch(/r\.status === 'cancelled' \? \(/);
    expect(page).toMatch(/>Cancelled</);
    // The DM badge belongs to Discord rows only.
    expect(page).toMatch(
      /r\.source === 'discord' && \(\s*<span[^>]*>\{r\.notified_at \? 'driver DM’d' : 'DM pending'\}/,
    );
    expect(page).toMatch(/name="custom_reason" rows="3" maxlength="500" required/);
    const users = ASTRO['/src/pages/admin/users/index.astro'];
    expect(users).toContain("'That driver is already linked to another account.'");
    expect(users).toContain('data-testid="users-driver-privacy-note"');
  });

  it('renders the editing tabs only for the owner, with no Save/Cancel under the bio (U3: BR4.2, BR5.1, NFR2.2)', () => {
    const page = ASTRO['/src/pages/drivers/[id].astro'];
    expect(page.match(/<ProfileSettingsTabs\b/g)).toHaveLength(1);
    expect(page).toMatch(/\{isOwner && ownerData && \(\s*<ProfileSettingsTabs\b/);
    expect(page).toMatch(/const ownerDataPromise[^;]*=\s*isOwner && session \? loadOwnerProfile\(/);
    // The old buttons under the bio are gone; the header's Save Profile and Cancel replace them.
    expect(page).not.toMatch(/<button[^>]*type="submit"/);
    expect(page).not.toContain('data-profile-cancel');
    expect(page).not.toMatch(/>\s*Save\s*</);
    // Data access through src/lib only.
    expect(page).not.toMatch(/rest\/v1|fetch\(/);
    // Owner renders are never cached: no-store is set after the shared public header (BR5.2, NFR2.1).
    const publicAt = page.indexOf("Astro.response.headers.set('Cache-Control', 'public, s-maxage=60");
    const noStoreAt = page.indexOf('if (loadError || isOwner) markUncacheable(Astro);');
    expect(publicAt).toBeGreaterThan(-1);
    expect(noStoreAt).toBeGreaterThan(publicAt);
    // The form the header button names, posting multipart to this page.
    expect(page).toMatch(/id: 'driver-profile-form',\s*method: 'post',\s*enctype: 'multipart\/form-data'/);
    expect(page).toMatch(/<input type="hidden" name="intent" value="save-profile" \/>/);
  });

  it('turns Edit Profile into Save Profile with a grey Cancel to its right (U3: BR4.1, BR4.5)', () => {
    const nav = ASTRO['/src/components/Nav.astro'];
    const toggle = /<button\s([^>]*data-profile-edit-toggle[^>]*)>([\s\S]*?)<\/button>/.exec(nav);
    expect(toggle, 'Nav has the Edit Profile toggle').not.toBeNull();
    expect(toggle![1]).toContain('form="driver-profile-form"');
    expect(toggle![1]).toContain('aria-label="Edit Profile"');
    expect(toggle![1]).toMatch(/class="btn btn-primary !px-2\.5"/);
    expect(toggle![2]).toContain('data-profile-icon-edit');
    expect(toggle![2]).toMatch(/<svg data-profile-icon-save[^>]*class="hidden h-5 w-5"/);

    const cancel = /\{onOwnProfile && \(([\s\S]*?)\)\}/.exec(
      nav.slice(nav.indexOf('data-profile-edit-toggle')),
    );
    expect(cancel, 'Cancel follows the toggle, own profile only').not.toBeNull();
    expect(cancel![1]).toMatch(/<span data-profile-cancel-wrap class="group relative hidden">/);
    expect(cancel![1]).toMatch(
      /<button type="button" data-profile-cancel class="btn btn-neutral !px-2\.5" aria-label="Cancel"/,
    );
    expect(cancel![1]).toMatch(/role="tooltip">Cancel</);
  });

  it('lays out the five tabs, the five checkboxes and the in-place buttons as designed (U3: M6a, M6b, C4)', () => {
    const tabs = ASTRO['/src/components/ProfileSettingsTabs.astro'];
    const labels = [...tabs.matchAll(/\{ id: '(tab-[a-z]+)', label: '([^']+)' \}/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    expect(labels).toEqual([
      'tab-privacy Profile & Privacy Settings',
      'tab-notifications Email Notifications',
      'tab-incidents Incident Management',
      'tab-interviews Interviews',
      'tab-liveries Liveries',
    ]);
    expect(tabs).toMatch(/role="tablist"[^>]*data-profile-tabs>/);
    for (const [name, label] of [
      ['hide_profile', 'Hide Profile from Anonymous Users'],
      ['hide_name', 'Hide Name from Anonymous Users'],
      ['notify_appeal_reviewed', 'Appeal Marked Reviewed'],
      ['notify_report_posted', 'Incident Report Posted'],
      ['notify_event_reminders', 'Event Reminders'],
    ]) {
      expect(tabs).toMatch(new RegExp(`name: '${name}',\\s*label: '${label}'`));
    }
    expect(tabs).toMatch(/Waiting for you to confirm \{pendingEmail\}/);
    expect(tabs).toMatch(/name="intent"\s+value="change-email"/);
    expect(tabs).toMatch(/name="intent"\s+value="reset-password"/);
    for (const button of tabs.match(/<button[^>]*>/g) ?? []) expect(button).toMatch(/class="btn btn-/);
  });

  it('lets no POST form opt back into the client router (BR5.1)', () => {
    const optIns = Object.entries(SRC).flatMap(([path, text]) =>
      [
        ...text.matchAll(
          /data-astro-reload=(?:["']false["']|\{false\})|removeAttribute\(['"]data-astro-reload['"]\)/g,
        ),
      ].map((m) => `${path}: ${m[0]}`),
    );
    expect(optIns).toEqual([]);
    expect(SRC['/src/scripts/hard-form-submit.ts']).toMatch(/form\.dataset\.astroReload = '';/);
    expect(SRC['/src/scripts/hard-form-submit.ts']).not.toMatch(/fetch\(/);
  });
});

describe('the Incident Management tab (U5: BR11.4-BR11.14, NFR1.8, NFR2.1)', () => {
  const PANEL = ASTRO['/src/components/IncidentManagementPanel.astro'];
  const DIALOGS = ASTRO['/src/components/IncidentManagementDialogs.astro'];
  const COMMENT_DIALOG = ASTRO['/src/components/IncidentCommentDialog.astro'];
  const SCRIPT = SRC['/src/scripts/incidentManagement.ts'];
  const PAGE = ASTRO[`${P}drivers/[id].astro`];

  it('fills the tab-incidents panel and renders only in the owner’s uncacheable render', () => {
    const tabs = ASTRO['/src/components/ProfileSettingsTabs.astro'];
    expect(tabs).toMatch(/data-profile-panel="tab-incidents"[^>]*>\s*<IncidentManagementPanel\b/);
    expect(importersOf('/src/components/IncidentManagementPanel.astro')).toEqual([
      '/src/components/ProfileSettingsTabs.astro',
    ]);
    expect(importersOf('/src/components/IncidentManagementDialogs.astro')).toEqual([
      `${P}drivers/[id].astro`,
    ]);
    expect(PAGE).toMatch(/const incidentDataPromise[^;]*=\s*isOwner && session \? loadIncidentPanel\(/);
    expect(PAGE).toMatch(/\{isOwner && incidentData && \(\s*<IncidentManagementDialogs\b/);
    // The popups sit after the profile form: a form can't hold another.
    expect(PAGE.indexOf('<IncidentManagementDialogs')).toBeGreaterThan(PAGE.indexOf('</ProfileTag>'));
    expect(PAGE).toContain('if (loadError || isOwner) markUncacheable(Astro);');
    expect(PAGE).toMatch(/import '\.\.\/\.\.\/scripts\/incidentDetails';/);
  });

  it('gives every state its text and uses the shared buttons (BR11.5, BR11.8, BR11.10, BR11.12, BR11.13)', () => {
    expect(PANEL).toContain('{row.statusLabel}');
    expect(PANEL).toContain('No incidents to manage.');
    expect(PANEL).toContain("Couldn't load your incidents. Try again later.");
    expect(PANEL).toContain('Showing your {MY_INCIDENTS_LIMIT} most recent incidents.');
    for (const [label, cls] of [
      ['Add Comment', 'btn btn-gold btn-sm'],
      ['View Incident', 'btn btn-primary btn-sm'],
      ['Submit Appeal', 'btn btn-gold btn-sm'],
      ['Appeal Submitted', 'btn btn-gold btn-sm'],
    ]) {
      expect(PANEL, label).toMatch(new RegExp(`class="${cls}"[^>]*>\\s*${label}\\s*<`));
    }
    expect(PANEL).toMatch(/disabled aria-disabled="true"[^>]*>\s*Appeal Submitted/);
    expect(PANEL).toMatch(/data-history-incident=\{row\.id\}/);
    // Inside the profile form, so no button here may submit it.
    for (const button of PANEL.match(/<button[^>]*>/g) ?? [])
      expect(button).toMatch(/type="button"[^>]*class="btn btn-/);
    expect(DIALOGS).toContain('<IncidentCommentDialog action={action} />');
    expect(COMMENT_DIALOG).toContain('Your comment is final and only stewards can see it.');
    expect(COMMENT_DIALOG).toMatch(/name="intent" value="add-incident-comment"/);
    expect(DIALOGS).toMatch(/name="intent" value="submit-appeal-from-profile"/);
  });

  it('never renders comment or appeal text as HTML (NFR1.8)', () => {
    for (const [name, text] of [
      ['panel', PANEL],
      ['dialogs', DIALOGS],
    ]) {
      expect(text, name).not.toContain('set:html');
    }
    expect(SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    expect(SCRIPT).toContain('setText(dialog, \'[data-incident-comment-field="description"]\'');
    const fragment = ASTRO[`${P}results/[subsessionId]/incidents/fragment.astro`];
    expect(fragment).toMatch(/<p class="mt-1 whitespace-pre-line text-white\/70">\{c\.body\}<\/p>/);
  });

  it('shows driver comments above the steward reviews in the admin report view (BR11.7)', () => {
    const fragment = ASTRO[`${P}results/[subsessionId]/incidents/fragment.astro`];
    const comments = fragment.indexOf('data-driver-comments');
    expect(comments).toBeGreaterThan(-1);
    expect(fragment.indexOf('Steward reviews: {reviewCount}')).toBeGreaterThan(comments);
    expect(fragment).toContain('>Driver comments</p>');
    expect(fragment).toMatch(/getDriverCommentsForReports\(supabaseEnv, token, incidentReports\.map/);
  });

  it('hides the round page’s Submit Appeal from signed-in drivers who are not involved (BR11.9)', () => {
    const fragment = ASTRO[`${P}results/[subsessionId]/incidents/fragment.astro`];
    expect(fragment).toMatch(/canAppeal: Astro\.locals\.session\s*\?/);
    expect(fragment).toContain("flash === 'notinvolved'");
    expect(fragment).toContain("flash === 'already'");
    const shell = ASTRO[`${P}results/[subsessionId]/incidents.astro`];
    expect(shell).toContain("appealBtn?.classList.toggle('hidden', summary.canAppeal === false);");
  });
});

describe('the Interviews tab (U6: BR12.1, BR12.6, BR12.7, NFR2.1)', () => {
  const PANEL = ASTRO['/src/components/InterviewsPanel.astro'];
  const SCRIPT = SRC['/src/scripts/interviews.ts'];
  const PAGE = ASTRO[`${P}drivers/[id].astro`];

  it('fills the tab-interviews panel and renders only in the owner’s uncacheable render', () => {
    const tabs = ASTRO['/src/components/ProfileSettingsTabs.astro'];
    expect(tabs).toMatch(/data-profile-panel="tab-interviews"[^>]*>\s*<InterviewsPanel\b/);
    expect(tabs).not.toContain("You haven't uploaded any interviews yet.");
    expect(importersOf('/src/components/InterviewsPanel.astro')).toEqual([
      '/src/components/ProfileSettingsTabs.astro',
    ]);
    expect(PAGE).toMatch(/const interviewsPromise[^;]*=\s*isOwner && session \? loadMyInterviews\(/);
    expect(PAGE).toMatch(/interviews=\{\{ rows: interviewRows, notice: interviewNotice \}\}/);
    expect(PAGE).toContain('if (loadError || isOwner) markUncacheable(Astro);');
    expect(PAGE).toMatch(/import '\.\.\/\.\.\/scripts\/interviews';/);
  });

  it('gives the icon buttons accessible names and the shared blue and red buttons, never submitting the form', () => {
    expect(PANEL).toMatch(
      /class="btn btn-primary btn-sm"\s+data-interview-download[\s\S]*?aria-label=\{`Download interview for \$\{row\.roundLabel\}`\}/,
    );
    expect(PANEL).toMatch(
      /class="btn btn-danger btn-sm"\s+data-interview-delete\b[\s\S]*?aria-label=\{`Delete interview for \$\{row\.roundLabel\}`\}/,
    );
    const buttons = PANEL.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(4);
    for (const button of buttons) expect(button).toMatch(/type="button"\s+class="btn btn-/);
    expect(PANEL).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(PANEL).not.toMatch(/<form\b/);
    expect(PANEL).toContain('href={row.roundHref}');
  });

  it('shows the empty state, the load error and the delete popup texts (BR12.4, BR12.6, NFR4.3)', () => {
    expect(PANEL).toContain('No interviews uploaded yet.');
    expect(PANEL).toContain("Couldn't load your interviews. Try again later.");
    expect(PANEL).toContain('data-interview-delete-dialog');
    expect(SCRIPT).toContain("inPlaceBody(intent, [['interview_id', id]])");
  });

  it('never renders interview text as HTML', () => {
    expect(PANEL).not.toContain('set:html');
    expect(SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  });
});

describe('the profile settings polish (profile-liveries FR2-FR4)', () => {
  const tabs = ASTRO['/src/components/ProfileSettingsTabs.astro'];
  const PAGE = ASTRO[`${P}drivers/[id].astro`];

  it('puts email and password side by side on wide screens, with a 40ch "Change Email" box (FR2.1-FR2.3)', () => {
    expect(tabs).toMatch(
      /<div class="grid gap-6 lg:grid-cols-2"[^>]*>\s*<section[^>]*>\s*<h2[^>]*>Email<\/h2>/,
    );
    expect(tabs).toMatch(/<h2 class="font-display text-2xl">Password<\/h2>[\s\S]*?<\/section>\s*<\/div>/);
    expect(tabs).toMatch(
      /<label class="flex w-full max-w-\[40ch\] flex-col[^>]*>\s*<span[^>]*>Change Email<\/span>/,
    );
    expect(tabs).not.toContain('New email');
  });

  it('relabels the name toggle with its new subtitle and locks the profile toggle while it is on (FR2.4, FR2.5)', () => {
    expect(tabs).toContain(`help: 'Shows "Hidden Driver" instead of your name to anyone not signed in.'`);
    expect(tabs).toContain("data-privacy-force={s.name === 'hide_name' ? 'source' : 'target'}");
    expect(tabs).toMatch(/type="hidden"\s+name="hide_profile"\s+value="on"\s+disabled=\{!profileLocked\}/);
    expect(tabs).toContain("disabled={!settingsLoaded || (s.name === 'hide_profile' && profileLocked)}");
  });

  it('drops the two privacy notes and the "Emails go to" line (FR2.7, FR3.1)', () => {
    expect(tabs).not.toContain('Changes may take a few minutes to apply everywhere.');
    expect(tabs).not.toContain('A league driver is any account linked to a driver.');
    expect(tabs).not.toContain('Emails go to');
  });

  it('removes the visible Bio label but keeps the box named for screen readers (FR4)', () => {
    expect(PAGE).not.toMatch(/<span[^>]*>Bio<\/span>/);
    expect(PAGE).toMatch(/<textarea\s+name="bio"\s+aria-label="Bio"/);
  });

  it('marks the current rulebook section with a dot and aria-current (FR1)', () => {
    const contents = ASTRO['/src/components/RulebookContents.astro'];
    expect(contents).toContain('data-rulebook-target={h.id}');
    expect(contents).toMatch(
      /<span data-rulebook-dot aria-hidden="true" class="hidden [^"]*rounded-full bg-brand-primary\b[^"]*"/,
    );
    expect(SRC['/src/scripts/rulebookContents.ts']).toContain(
      "link.setAttribute('aria-current', 'location')",
    );
  });
});

describe('the Liveries tab (profile-liveries FR5, NFR3-NFR6)', () => {
  const PANEL = ASTRO['/src/components/LiveriesPanel.astro'];
  const SCRIPT = SRC['/src/scripts/liveries.ts'];
  const PAGE = ASTRO[`${P}drivers/[id].astro`];
  const tabs = ASTRO['/src/components/ProfileSettingsTabs.astro'];

  it('fills the tab-liveries panel only for linked accounts, in the owner’s uncacheable render (FR5.1)', () => {
    expect(tabs).toMatch(
      /\{liveries\.linked && \(\s*<div role="tabpanel" id="tab-liveries"[^>]*>\s*<LiveriesPanel\b/,
    );
    expect(tabs).toContain("ALL_TABS.filter((tab) => tab.id !== 'tab-liveries' || liveries.linked)");
    expect(importersOf('/src/components/LiveriesPanel.astro')).toEqual([
      '/src/components/ProfileSettingsTabs.astro',
    ]);
    expect(PAGE).toMatch(/const liveriesPromise[^;]*=\s*isOwner && session \? loadMyLiveries\(/);
    expect(PAGE).toMatch(/import '\.\.\/\.\.\/scripts\/liveries';/);
  });

  it('uses shared buttons that never submit the profile form, with names on the icon buttons (NFR5, NFR6)', () => {
    const buttons = PANEL.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(10);
    for (const button of buttons.join('\n').split(/(?=<button)/))
      expect(button).toMatch(/type="button"\s+class="btn btn-/);
    for (const name of ['View preview of', 'Download', 'Delete']) {
      expect(PANEL).toMatch(new RegExp(`aria-label=\\{\`${name} \\$\\{row\\.tgaName\\}\`\\}`));
    }
    expect(PANEL).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(PANEL).not.toMatch(/<form\b/);
  });

  it('gives the file pickers and dropdowns no name, so Save Profile never posts them', () => {
    const controls = PANEL.match(/<(?:input|select)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThanOrEqual(4);
    for (const control of controls) expect(control).not.toMatch(/\sname=/);
    expect(PANEL).toContain('accept=".tga"');
    expect(PANEL).toContain('accept=".mip"');
  });

  it('labels the spec map button by state and marks the active livery (FR5.6, FR5.8)', () => {
    expect(PANEL).toContain("{row.mipName ? 'Replace spec map' : 'Add spec map'}");
    expect(PANEL).toMatch(/\{!row\.isActive && \(\s*<button[^>]*data-livery-set-active/);
    expect(PANEL).toContain('data-testid="livery-active-badge"');
    expect(PANEL).toContain('data-livery-preview-dialog');
    expect(PANEL).toContain('data-livery-delete-dialog');
  });

  it('never renders livery text as HTML and moves file bytes only between the browser and Storage (NFR4)', () => {
    expect(PANEL).not.toContain('set:html');
    expect(SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    expect(SCRIPT).toContain("new CompressionStream('gzip')");
    expect(SCRIPT).toContain("new DecompressionStream('gzip')");
    expect(SCRIPT).toMatch(/method: 'PUT'/);
  });
});

describe('driver privacy rendering (U4: BR9.8, BR9.11, BR9.14, NFR2.2)', () => {
  const PRIVATE_PAGES = [
    `${P}drivers/[id].astro`,
    `${P}drivers/[id]/fragment.astro`,
    `${P}drivers/[id]/awards.astro`,
    `${P}champions/season-results/[seasonId]/[driverId].astro`,
  ];

  it('builds DriverLink’s href only through driverHref, so a hidden driver gets no link', () => {
    const link = ASTRO['/src/components/DriverLink.astro'];
    expect(link).toMatch(/hidden\?: boolean \| null;/);
    expect(link).toContain('driverHref({ id, is_hidden: hidden })');
    expect(link).toMatch(/\{href \? <a href=\{href\}[^>]*><slot \/><\/a> : <slot \/>\}/);
    expect(link).not.toContain('/drivers/${');
  });

  it('passes the hidden flag at every DriverLink call', () => {
    const missing = Object.entries(ASTRO).flatMap(([path, text]) =>
      [...text.matchAll(/<DriverLink\b[^>]*>/g)]
        .filter((m) => !/\bhidden=\{/.test(m[0]))
        .map((m) => `${path}: ${m[0]}`),
    );
    expect(missing).toEqual([]);
  });

  it('gives the roster row a profile link only when the driver is not hidden', () => {
    const row = ASTRO['/src/components/DriverRow.astro'];
    expect(row).toContain('const href = driverHref(driver);');
    expect(row).toContain('data-driver-link={href ?? undefined}');
    expect(row).toMatch(/role=\{href \? 'link' : undefined\}/);
  });

  it('renders the private notice on every profile route and guards the data with !privateProfile (BR9.11)', () => {
    for (const path of PRIVATE_PAGES) {
      const page = ASTRO[path];
      expect(page, path).toMatch(
        /\{privateProfile && <PrivateProfileNotice driverId=\{driverId\} signedIn=\{Boolean\(/,
      );
      expect(page, path).toMatch(/!privateProfile/);
    }
    const shell = ASTRO[`${P}drivers/[id].astro`];
    expect(shell).toContain('{!loadError && driver && !privateProfile && (');
    // No fragment request, private title and a generic description for a private profile (NFR2.2).
    expect(shell).toMatch(/const fragmentUrl =\s*!loadError && driver && !privateProfile/);
    expect(shell).toContain("const pageTitle = privateProfile ? 'Private profile'");
    expect(shell).toContain("? 'A driver profile.'");
    expect(shell).toContain('if (!loadError && driver && !privateProfile) {');
  });

  it('shows only the notice text and one shared button in the private notice (NFR2.2)', () => {
    const notice = ASTRO['/src/components/PrivateProfileNotice.astro'];
    expect(notice).toContain("This driver's profile is private.");
    expect(notice).toContain('<a href={action.href} class="btn btn-primary mt-4">{action.label}</a>');
    for (const leak of ['data-fragment-url', 'bio', 'photo', 'name}', 'stats'])
      expect(notice).not.toContain(leak);
  });

  it('never derives the profile photo badge from the name (Q7 A)', () => {
    const shell = ASTRO[`${P}drivers/[id].astro`];
    expect(shell).not.toMatch(/displayName\.charAt\(0\)/);
    expect(shell).toContain('resizedImageUrl(driverPhoto(driver), { width: 320 })');
    expect(shell).toContain('{photoBadge}');
  });

  it('says under the Hide Driver Name toggle that a same-named driver is hidden too (BR9.8)', () => {
    const tabs = ASTRO['/src/components/ProfileSettingsTabs.astro'];
    expect(tabs).toMatch(
      /name: 'hide_name',[\s\S]*?note: 'In news and incident text, another driver with exactly the same full name is hidden too\.'/,
    );
    expect(tabs).toContain(
      '{s.note && <p class="text-xs text-white/40" data-setting-note={s.name}>{s.note}</p>}',
    );
  });

  it('renders a hidden driver as plain text in the client-built recap and meetup lists', () => {
    expect(ASTRO[`${P}calendar.astro`]).toMatch(
      /if \(driver\.is_hidden\) \{\s*const span = document\.createElement\('span'\);/,
    );
    expect(ASTRO[`${P}media.astro`]).toMatch(/if \(!driver\.id\) \{\s*li\.textContent = driver\.label;/);
    expect(ASTRO[`${P}media/fragment.astro`]).toContain('id: link.drivers.is_hidden ? null : link.driver_id');
  });
});
