/**
 * The three notification emails (BR10.14, Q4 A): pure string builders. Every value from the database is
 * HTML-escaped, links are SITE_URL plus a fixed path and a validated id, and each email names the setting
 * that sent it with a link to the profile where it is turned off. Rendering never throws: a missing value
 * falls back to neutral wording, so one odd row can't hold up a batch.
 */
import { LEAGUE_TIME_ZONE } from '../timezone';

export type NotificationKind = 'appeal_reviewed' | 'report_posted' | 'event_reminder';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface RenderContext {
  siteUrl: string;
  /** The claim time; it fixes "today" or "tomorrow" in a reminder. */
  now: Date;
}

/** The setting names, exactly as the profile's Notifications tab shows them. */
export const SETTING_NAMES: Record<NotificationKind, string> = {
  appeal_reviewed: 'Appeal Marked Reviewed',
  report_posted: 'Incident Report Posted',
  event_reminder: 'Event Reminders',
};

const SUBSESSION_ID = /^\d{1,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Built once: creating an Intl formatter costs far more CPU than using one.
const ET_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: LEAGUE_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
});
const ET_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: LEAGUE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A payload value as one trimmed line of text, or null. */
function field(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/** "Zr Season Round 3", else the track, else a neutral phrase. */
export function roundLabel(payload: Record<string, unknown>): string {
  const season = field(payload, 'season_label');
  const round = field(payload, 'round_number');
  const parts = [season, round && /^\d+$/.test(round) ? `Round ${round}` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : (field(payload, 'track_name') ?? 'a recent round');
}

function eventLabel(payload: Record<string, unknown>): string {
  const name = field(payload, 'event_name');
  const season = field(payload, 'season_label');
  const round = field(payload, 'round_number');
  if (season && round && /^\d+$/.test(round))
    return name ? `${season} Round ${round} at ${name}` : `${season} Round ${round}`;
  return name ?? 'The next event';
}

function incidentsUrl(siteUrl: string, payload: Record<string, unknown>): string {
  const id = field(payload, 'subsession_id');
  return id && SUBSESSION_ID.test(id) ? `${siteUrl}/results/${id}/incidents` : `${siteUrl}/incidents`;
}

function briefingUrl(siteUrl: string, payload: Record<string, unknown>): string {
  const id = field(payload, 'event_id');
  return id && UUID.test(id) ? `${siteUrl}/briefing/${id}` : `${siteUrl}/calendar`;
}

/** "8:00 PM" and whether the start falls on the send day's ET date ("today") or a later one ("tomorrow"). */
export function startWording(startsAt: Date, now: Date): { time: string; day: 'today' | 'tomorrow' } {
  // Node and browsers put a narrow no-break space before AM/PM; mail clients show a plain one more reliably.
  const time = ET_TIME.format(startsAt).replace(/ /g, ' ');
  return { time, day: ET_DATE.format(startsAt) === ET_DATE.format(now) ? 'today' : 'tomorrow' };
}

interface EmailParts {
  subject: string;
  lead: string;
  linkText: string;
  linkUrl: string;
}

function render(kind: NotificationKind, parts: EmailParts, siteUrl: string): RenderedEmail {
  const setting = SETTING_NAMES[kind];
  const profileUrl = `${siteUrl}/my-profile`;
  const footer = `You are getting this email because "${setting}" is on in your profile settings.`;
  const html =
    '<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#0B0B0E;line-height:1.5">' +
    `<p>${escapeHtml(parts.lead)}</p>` +
    `<p><a href="${escapeHtml(parts.linkUrl)}">${escapeHtml(parts.linkText)}</a></p>` +
    `<hr><p style="font-size:12px">${escapeHtml(footer)} ` +
    `<a href="${escapeHtml(profileUrl)}">Turn it off on your profile</a>.</p></body></html>`;
  const text =
    `${parts.lead}\n\n${parts.linkText}: ${parts.linkUrl}\n\n` +
    `${footer}\nTurn it off on your profile: ${profileUrl}\n`;
  return { subject: parts.subject, html, text };
}

function reminderParts(payload: Record<string, unknown>, context: RenderContext): EmailParts {
  const event = eventLabel(payload);
  const startsAt = new Date(field(payload, 'starts_at') ?? '');
  const when = Number.isNaN(startsAt.getTime()) ? null : startWording(startsAt, context.now);
  const timing = when ? `starts at ${when.time} ET ${when.day}` : 'starts soon';
  return {
    subject: `Reminder: ${event} ${timing}`,
    lead: `${event} ${timing}.`,
    linkText: 'Open the event briefing',
    linkUrl: briefingUrl(context.siteUrl, payload),
  };
}

export function renderEmail(
  kind: NotificationKind,
  payload: Record<string, unknown> | null,
  context: RenderContext,
): RenderedEmail {
  const values = payload ?? {};
  const siteUrl = context.siteUrl.replace(/\/+$/, '');
  if (kind === 'appeal_reviewed') {
    return render(
      kind,
      {
        subject: 'Your appeal has been reviewed',
        lead: `The stewards have reviewed your appeal for ${roundLabel(values)}. The decision is on the round's incidents page.`,
        linkText: 'View the incidents',
        linkUrl: incidentsUrl(siteUrl, values),
      },
      siteUrl,
    );
  }
  if (kind === 'report_posted') {
    const label = roundLabel(values);
    return render(
      kind,
      {
        subject: `Incident report posted: ${label}`,
        lead: `The incident report for ${label} is now posted.`,
        linkText: 'Read the incident report',
        linkUrl: incidentsUrl(siteUrl, values),
      },
      siteUrl,
    );
  }
  return render(kind, reminderParts(values, { ...context, siteUrl }), siteUrl);
}
