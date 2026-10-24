/**
 * The three notification emails (U7: BR10.14, NFR5.2, AC6.1.3): subjects, the setting each names, links built
 * only from SITE_URL and validated ids, HTML escaping, and "today" or "tomorrow" by Eastern dates, across a
 * daylight-saving change.
 */
import { describe, expect, it } from 'vitest';
import { escapeHtml, renderEmail, roundLabel, startWording } from '../../src/lib/notifications/templates';

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

describe('helpers', () => {
  it('escapes the five HTML characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('ignores a round number that is not a number', () => {
    expect(roundLabel({ season_label: 'S', round_number: 'x' })).toBe('S');
  });
});
