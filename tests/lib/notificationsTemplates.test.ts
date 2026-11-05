/**
 * The three notification emails (U7: BR10.14, NFR5.2, AC6.1.3): subjects, the setting each names, links built
 * only from SITE_URL and validated ids, HTML escaping, and "today" or "tomorrow" by Eastern dates, across a
 * daylight-saving change.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATE_TEXT,
  SAMPLE_PLACEHOLDER_VALUES,
  escapeHtml,
  previewTemplate,
  renderEmail,
  roundLabel,
  startWording,
  type EmailTemplateSet,
  type EmailTemplateText,
} from '../../src/lib/notifications/templates';
import { fillPlaceholders } from '../../src/lib/notifications/templateRules';

const SITE = 'https://site.example.test';
const context = { siteUrl: SITE, now: new Date('2026-10-24T13:00:00Z') };
const round = { subsession_id: 9907001, season_label: 'Zr Season', round_number: 3, track_name: 'Zr Park' };

describe('renderEmail', () => {
  it('builds the appeal email with its subject, incidents link and setting', () => {
    const email = renderEmail('appeal_reviewed', { appeal_id: 'a', ...round }, context);
    expect(email.subject).toBe('Your appeal has been reviewed');
    expect(email.html).toContain(`href="${SITE}/results/9907001/incidents"`);
    expect(email.html).toContain('&quot;Appeal Marked Reviewed&quot; is on in your profile settings');
    expect(email.html).toContain(`href="${SITE}/my-profile"`);
    expect(email.text).toContain(`${SITE}/results/9907001/incidents`);
    expect(email.text).toContain('Turn it off on your profile: https://site.example.test/my-profile');
  });

  it('names the round in the report subject and falls back when values are missing', () => {
    expect(renderEmail('report_posted', round, context).subject).toBe(
      'Incident report posted: Zr Season Round 3',
    );
    expect(renderEmail('report_posted', { track_name: 'Zr Park' }, context).subject).toBe(
      'Incident report posted: Zr Park',
    );
    expect(renderEmail('report_posted', null, context).subject).toBe(
      'Incident report posted: a recent round',
    );
    expect(renderEmail('report_posted', round, context).html).toContain('Incident Report Posted');
  });

  it('says "today" when the reminder goes out on the start’s Eastern date', () => {
    const email = renderEmail(
      'event_reminder',
      {
        event_id: 'dddddddd-0000-4000-8000-000000000701',
        event_name: 'Zr Circuit',
        season_label: 'Zr Season',
        round_number: 4,
        starts_at: '2026-10-25T00:00:00+00:00',
      },
      context,
    );
    expect(email.subject).toBe('Reminder: Zr Season Round 4 at Zr Circuit starts at 8:00 PM ET today');
    expect(email.html).toContain(`href="${SITE}/briefing/dddddddd-0000-4000-8000-000000000701"`);
    expect(email.html).toContain('Event Reminders');
  });

  it('says "tomorrow" when the start falls on the next Eastern date', () => {
    const email = renderEmail(
      'event_reminder',
      { event_name: 'Zr Circuit', starts_at: '2026-10-25T05:30:00Z' },
      { siteUrl: SITE, now: new Date('2026-10-24T17:45:00Z') },
    );
    expect(email.subject).toBe('Reminder: Zr Circuit starts at 1:30 AM ET tomorrow');
  });

  it('escapes every database value in the HTML part (NFR5.2)', () => {
    const hostile = '<script>alert("x")</script> & \'quotes\'';
    const email = renderEmail('report_posted', { ...round, season_label: hostile }, context);
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;');
    const reminder = renderEmail(
      'event_reminder',
      { event_name: '"><img src=x>', starts_at: 'not a date' },
      context,
    );
    expect(reminder.html).not.toContain('<img');
    expect(reminder.subject).toBe('Reminder: "><img src=x> starts soon');
  });

  it('builds links only from SITE_URL and validated ids', () => {
    const report = renderEmail(
      'report_posted',
      { ...round, subsession_id: 'javascript:alert(1)' },
      { siteUrl: `${SITE}/`, now: context.now },
    );
    expect(report.html).toContain(`href="${SITE}/incidents"`);
    expect(report.html).not.toContain('javascript:');
    const reminder = renderEmail(
      'event_reminder',
      { event_id: '../admin', starts_at: '2026-10-25T00:00:00Z' },
      context,
    );
    expect(reminder.html).toContain(`href="${SITE}/calendar"`);
  });
});

describe('startWording', () => {
  it('converts with the Eastern offset on each side of the daylight-saving change', () => {
    // 20:00 EDT on Oct 31, and 20:00 EST on Nov 1.
    expect(startWording(new Date('2026-11-01T00:00:00Z'), new Date('2026-10-31T13:00:00Z'))).toEqual({
      time: '8:00 PM',
      day: 'today',
    });
    expect(startWording(new Date('2026-11-02T01:00:00Z'), new Date('2026-11-01T14:00:00Z'))).toEqual({
      time: '8:00 PM',
      day: 'today',
    });
  });

  it('compares Eastern dates, not UTC dates', () => {
    // Both instants are Oct 25 in UTC, but 23:30 ET on Oct 24 and 00:30 ET on Oct 25 are a day apart.
    expect(startWording(new Date('2026-10-25T04:30:00Z'), new Date('2026-10-25T03:30:00Z')).day).toBe(
      'tomorrow',
    );
  });
});

describe('renderEmail with edited wording (FR2.2-FR2.6; BR2.3-BR2.5)', () => {
  const reminder = {
    event_id: '11111111-2222-3333-4444-555555555555',
    event_name: 'Sonoma',
    season_label: 'ATC18',
    round_number: 3,
    starts_at: '2026-10-25T00:00:00Z',
  };
  const edited = (
    kind: keyof typeof DEFAULT_TEMPLATE_TEXT,
    text: Partial<EmailTemplateText>,
  ): EmailTemplateSet => ({
    [kind]: { subject: null, lead: null, link_text: null, ...text },
  });

  it('sends exactly the built-in wording with no templates, an empty set or all-null fields', () => {
    for (const kind of ['appeal_reviewed', 'report_posted', 'event_reminder'] as const) {
      const payload = { ...round, ...reminder };
      const builtIn = renderEmail(kind, payload, context);
      expect(renderEmail(kind, payload, context, {})).toEqual(builtIn);
      expect(renderEmail(kind, payload, context, edited(kind, {}))).toEqual(builtIn);
    }
  });

  it('the default text with placeholders fills to the built-in wording', () => {
    const email = renderEmail('report_posted', round, context);
    expect(
      fillPlaceholders(DEFAULT_TEMPLATE_TEXT.report_posted.subject, { round: 'Zr Season Round 3' }),
    ).toBe(email.subject);
    const sent = renderEmail('event_reminder', reminder, context);
    const when = startWording(new Date(reminder.starts_at), context.now);
    expect(
      fillPlaceholders(DEFAULT_TEMPLATE_TEXT.event_reminder.subject, {
        event: 'ATC18 Round 3 at Sonoma',
        ...when,
      }),
    ).toBe(sent.subject);
  });

  it('uses each edited field on its own and keeps the link address and footer fixed', () => {
    const email = renderEmail(
      'report_posted',
      round,
      context,
      edited('report_posted', { subject: 'Posted: {round}', link_text: 'Read it' }),
    );
    expect(email.subject).toBe('Posted: Zr Season Round 3');
    expect(email.html).toContain('The incident report for Zr Season Round 3 is now posted.');
    expect(email.html).toContain(`<a href="${SITE}/results/9907001/incidents">Read it</a>`);
    expect(email.text).toContain(`Read it: ${SITE}/results/9907001/incidents`);
    expect(email.html).toContain('Turn it off on your profile');
  });

  it('falls back field by field for an unknown placeholder, an over-long field or a line break', () => {
    const email = renderEmail(
      'appeal_reviewed',
      round,
      context,
      edited('appeal_reviewed', { subject: 'Hi {driver}', lead: 'x'.repeat(1001), link_text: 'Open\nit' }),
    );
    expect(email).toEqual(renderEmail('appeal_reviewed', round, context));
  });

  it('never expands a placeholder inside a filled value', () => {
    const email = renderEmail(
      'event_reminder',
      { ...reminder, event_name: '{time} Raceway' },
      context,
      edited('event_reminder', { subject: '{event} at {time}' }),
    );
    expect(email.subject).toMatch(/^ATC18 Round 3 at \{time\} Raceway at \d{1,2}:\d{2} [AP]M$/);
  });

  it('keeps the built-in "starts soon" for fields using {time} or {day} when the start is unknown', () => {
    const email = renderEmail(
      'event_reminder',
      { ...reminder, starts_at: 'not a date' },
      context,
      edited('event_reminder', { subject: '{event} at {time}', lead: 'Get ready for {event}!' }),
    );
    expect(email.subject).toBe('Reminder: ATC18 Round 3 at Sonoma starts soon');
    expect(email.text.startsWith('Get ready for ATC18 Round 3 at Sonoma!')).toBe(true);
  });

  it('escapes admin text and values in the HTML, keeps line breaks, and leaves the plain text unescaped', () => {
    const email = renderEmail(
      'report_posted',
      { ...round, season_label: 'R&D <Cup>' },
      context,
      edited('report_posted', { lead: 'Hello <b>drivers</b>,\nthe {round} report is up.' }),
    );
    expect(email.html).toContain(
      '<p>Hello &lt;b&gt;drivers&lt;/b&gt;,<br>the R&amp;D &lt;Cup&gt; Round 3 report is up.</p>',
    );
    expect(email.text.startsWith('Hello <b>drivers</b>,\nthe R&D <Cup> Round 3 report is up.\n\n')).toBe(
      true,
    );
  });
});

describe('previewTemplate (FR2.4)', () => {
  it('fills the typed wording with the sample values and shows defaults for empty fields', () => {
    const preview = previewTemplate('report_posted', {
      subject: 'Posted: {round}',
      lead: null,
      link_text: '',
    });
    expect(preview.subject).toBe(`Posted: ${SAMPLE_PLACEHOLDER_VALUES.round}`);
    expect(preview.lead).toBe(`The incident report for ${SAMPLE_PLACEHOLDER_VALUES.round} is now posted.`);
    expect(preview.linkText).toBe('Read the incident report');
    expect(preview.footer).toContain('"Incident Report Posted"');
  });

  it('shows the default for a field that would fall back when sent', () => {
    const preview = previewTemplate('event_reminder', { subject: 'Hi {round}' });
    expect(preview.subject).toBe('Reminder: ATC18 Round 3 at Sonoma starts at 8:00 PM ET tomorrow');
  });
});

describe('helpers', () => {
  it('escapes the five HTML characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('ignores a round number that is not a number', () => {
    expect(roundLabel({ season_label: 'S', round_number: 'x' })).toBe('S');
  });
});
