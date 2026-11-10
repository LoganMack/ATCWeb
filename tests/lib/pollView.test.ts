/**
 * The shared poll renderer (src/lib/polls/view.ts; polls BR3.2, BR3.3, FR1.8): every answer type, disabled
 * controls with no submit button, escaped text, only safe image URLs, and the notes.
 */
import { describe, expect, it } from 'vitest';
import { pollViewHtml } from '../../src/lib/polls/view';
import type { PollView } from '../../src/lib/polls/types';

const view: PollView = {
  title: 'Next season',
  description: 'Pick wisely.\nVotes open soon.',
  sections: [
    {
      name: 'Track',
      answerType: 'single',
      options: [
        { name: 'Spa', imageUrl: '/cdn-cgi/image/width=320/https://x.supabase.co/a.png' },
        { name: 'Monza', imageUrl: null },
      ],
    },
    {
      name: 'Cars',
      answerType: 'multiple',
      options: [
        { name: 'GT3', imageUrl: null },
        { name: 'GT4', imageUrl: null },
      ],
    },
    {
      name: 'Rate',
      answerType: 'stars',
      options: [{ name: 'Season', imageUrl: 'blob:http://localhost/abc' }],
    },
  ],
};

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

describe('pollViewHtml', () => {
  it('draws radio buttons, checkboxes and five stars per option', () => {
    const html = pollViewHtml(view);
    expect(count(html, /type="radio" name="poll-s0"/g)).toBe(2);
    expect(count(html, /type="checkbox" name="poll-s1"/g)).toBe(2);
    expect(count(html, /type="radio" name="poll-s2-o0" value="[1-5]"/g)).toBe(5);
    expect(html).toContain('Pick one');
    expect(html).toContain('Pick several');
    expect(html).toContain('Star rating');
  });

  it('disables every control and renders no submit control or form', () => {
    const html = pollViewHtml(view);
    const inputs = html.match(/<input[^>]*>/g) ?? [];
    expect(inputs.length).toBe(9);
    for (const input of inputs) expect(input).toMatch(/\sdisabled[\s>]/);
    expect(count(html, /<fieldset disabled/g)).toBe(3);
    expect(html).not.toMatch(/<form|<button|type="submit"/);
  });

  it('escapes every piece of text', () => {
    const html = pollViewHtml(
      {
        title: '<script>alert(1)</script>',
        description: 'a & b',
        sections: [
          { name: '"><img src=x>', answerType: 'stars', options: [{ name: "O'Neil <b>", imageUrl: null }] },
        ],
      },
      { note: '<i>soon</i>' },
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('a &amp; b');
    expect(html).toContain('O&#39;Neil &lt;b&gt;');
    expect(html).toContain('&lt;i&gt;soon&lt;/i&gt;');
  });

  it('shows resized and local preview images, and drops any other URL', () => {
    const html = pollViewHtml(view);
    expect(html).toContain('src="/cdn-cgi/image/width=320/https://x.supabase.co/a.png"');
    expect(html).toContain('src="blob:http://localhost/abc"');
    expect(count(html, /data-poll-option-image/g)).toBe(2);
    const bad = pollViewHtml({
      ...view,
      sections: [
        {
          name: 'S',
          answerType: 'single',
          options: [
            { name: 'A', imageUrl: 'javascript:alert(1)' },
            { name: 'B', imageUrl: '//evil.test/x.png' },
          ],
        },
      ],
    });
    expect(bad).not.toContain('<img');
  });

  it('shows the note when given, and the description only when there is one', () => {
    expect(pollViewHtml(view, { note: 'Voting opens soon' })).toContain(
      'data-poll-note>Voting opens soon</p>',
    );
    expect(pollViewHtml(view, { note: 'This poll has closed' })).toContain('This poll has closed');
    expect(pollViewHtml(view)).not.toContain('data-poll-note');
    expect(pollViewHtml({ ...view, description: null })).not.toContain('whitespace-pre-line');
  });

  it('keeps sections and options in the given order', () => {
    const html = pollViewHtml(view);
    expect(html.indexOf('Track')).toBeLessThan(html.indexOf('Cars'));
    expect(html.indexOf('Spa')).toBeLessThan(html.indexOf('Monza'));
  });
});
