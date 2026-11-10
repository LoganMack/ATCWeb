// The nav's status badges and the notifications bell (notifications U3; BR1.2, BR1.3, BR2.1, BR2.2). Imported
// by Nav.astro, which renders the bell on every page for driver-linked accounts. One /api/nav-status request
// per page fills both the bell dot and the Admin Panel gear badge.
import { bellLabel, relativeTime, unreadBadgeText, type NotificationItem } from '../lib/inbox/messages';

export interface NavStatusResponse {
  unread?: number;
  pendingSignups?: number;
}

interface FlagHolder {
  dataset: DOMStringMap;
}

/**
 * True the first time it is called for a page URL. Fragment pages fire astro:page-load twice, and a driver
 * with no gear has no gear flag, so the guard sits on <html>, keyed by the URL.
 */
export function claimNavStatusFetch(root: FlagHolder, pageUrl: string): boolean {
  if (root.dataset.navStatusFor === pageUrl) return false;
  root.dataset.navStatusFor = pageUrl;
  return true;
}

interface BadgeTarget {
  textContent: string | null;
  classList: Pick<DOMTokenList, 'toggle'>;
}
interface LabelTarget {
  setAttribute(name: string, value: string): void;
}

export interface NavStatusTargets {
  gear?: LabelTarget | null;
  badge?: BadgeTarget | null;
  bell?: LabelTarget | null;
  dot?: BadgeTarget | null;
}

/** Shows the bell's unread count (hidden at 0) and puts it in the bell's accessible name. */
export function setBellCount(bell: LabelTarget, dot: BadgeTarget, count: number): void {
  const text = unreadBadgeText(count);
  dot.textContent = text;
  dot.classList.toggle('hidden', text === '');
  bell.setAttribute('aria-label', bellLabel(count));
}

/** Fills whatever the response carries; a part left out keeps its badge hidden. */
export function applyNavStatus(status: NavStatusResponse, targets: NavStatusTargets): void {
  const pending = status.pendingSignups;
  if (typeof pending === 'number' && pending > 0 && targets.gear && targets.badge) {
    targets.badge.textContent = pending > 9 ? '9+' : String(pending);
    targets.badge.classList.toggle('hidden', false);
    targets.gear.setAttribute(
      'aria-label',
      `Admin Panel (${pending} pending sign-up${pending === 1 ? '' : 's'})`,
    );
  }
  if (typeof status.unread === 'number' && targets.bell && targets.dot) {
    setBellCount(targets.bell, targets.dot, status.unread);
  }
}

async function loadNavStatus(): Promise<void> {
  const gear = document.querySelector<HTMLAnchorElement>('[data-admin-gear]');
  const badge = gear?.querySelector<HTMLElement>('[data-pending-signups-badge]') ?? null;
  const bell = document.querySelector<HTMLButtonElement>('[data-notifications-bell]');
  const dot = bell?.querySelector<HTMLElement>('[data-notifications-dot]') ?? null;
  if (!badge && !dot) return;
  if (!claimNavStatusFetch(document.documentElement, location.pathname + location.search)) return;
  try {
    const res = await fetch('/api/nav-status');
    if (!res.ok) return;
    applyNavStatus((await res.json()) as NavStatusResponse, { gear, badge, bell, dot });
  } catch {
    /* leave both badges hidden */
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderMessage(body: HTMLElement, text: string): void {
  body.replaceChildren(el('p', 'px-3 py-6 text-center text-sm text-white/60', text));
}

function renderError(body: HTMLElement, retry: () => void): void {
  const wrap = el('div', 'flex flex-col items-center gap-3 px-3 py-6 text-center');
  wrap.append(el('p', 'text-sm text-white/60', "Couldn't load notifications"));
  const button = el('button', 'btn btn-neutral', 'Retry');
  button.type = 'button';
  button.dataset.testid = 'notifications-retry';
  button.addEventListener('click', retry);
  wrap.append(button);
  body.replaceChildren(wrap);
}

function renderItems(body: HTMLElement, items: NotificationItem[]): void {
  if (items.length === 0) return renderMessage(body, 'No notifications yet');
  const list = el('ul', 'flex flex-col gap-0.5');
  const now = new Date();
  for (const item of items) {
    const link = el('a', 'block rounded-md px-3 py-2.5 transition hover:bg-white/[0.06]');
    link.href = item.href;
    link.append(el('span', 'block text-sm text-white', item.message));
    const meta = el('span', 'mt-1 flex items-center gap-2 text-xs text-white/50');
    meta.append(el('span', '', relativeTime(item.createdAt, now)));
    // A word, not colour alone, marks what was unread (NFR6).
    if (item.unread)
      meta.append(
        el('span', 'rounded bg-brand-gold px-1.5 text-[10px] font-bold uppercase text-brand-ink', 'New'),
      );
    link.append(meta);
    const row = el('li', '');
    row.append(link);
    list.append(row);
  }
  body.replaceChildren(list);
}

/** Lists and marks read in one call; on failure the dot stays as it was and Retry tries again. */
async function openPopup(bell: HTMLButtonElement, dialog: HTMLDialogElement): Promise<void> {
  const body = dialog.querySelector<HTMLElement>('[data-notifications-body]');
  const dot = bell.querySelector<HTMLElement>('[data-notifications-dot]');
  if (!body) return;
  renderMessage(body, 'Loading…');
  try {
    const res = await fetch('/api/notifications/open', { method: 'POST' });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { items: NotificationItem[]; unread: number };
    renderItems(body, data.items);
    if (dot) setBellCount(bell, dot, data.unread);
  } catch {
    renderError(body, () => void openPopup(bell, dialog));
  }
}

function onDocumentClick(e: Event): void {
  const target = e.target as HTMLElement | null;
  const bell = target?.closest?.<HTMLButtonElement>('[data-notifications-bell]');
  const dialog = document.querySelector<HTMLDialogElement>('dialog[data-notifications-dialog]');
  if (!dialog) return;
  if (bell) {
    if (!dialog.open) {
      dialog.showModal();
      void openPopup(bell, dialog);
    }
    return;
  }
  // The close button, or a click on the backdrop (the <dialog> itself, outside its content).
  if (target?.closest?.('[data-close-notifications]') || target === dialog) dialog.close();
}

function bindDialog(): void {
  const dialog = document.querySelector<HTMLDialogElement>('dialog[data-notifications-dialog]');
  if (!dialog || dialog.dataset.notificationsBound === 'true') return;
  dialog.dataset.notificationsBound = 'true';
  // Escape and the close button both end here; focus goes back to the bell.
  dialog.addEventListener('close', () => {
    document.querySelector<HTMLButtonElement>('[data-notifications-bell]')?.focus();
  });
}

// Module-scoped: the client router swaps <body>, so a body flag would bind a second click listener.
let initialized = false;
function init(): void {
  bindDialog();
  void loadNavStatus();
  if (initialized) return;
  initialized = true;
  document.addEventListener('click', onDocumentClick);
}

if (typeof document !== 'undefined') {
  document.addEventListener('astro:page-load', init);
}
