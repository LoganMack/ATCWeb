/**
 * The poll editor's server-side checks (src/lib/polls/validate.ts; polls BR1.1-BR1.4, BR2.4, BR4.1): limits,
 * option counts per answer type, names unique ignoring case, the closing date rule, image type, size and count,
 * and the save_poll payload built from a passing form.
 */
import { describe, expect, it } from 'vitest';
import {
  POLL_IMAGE_MAX_BYTES,
  POLL_NEW_IMAGES_MAX,
  charLength,
  parsePollForm,
  pollSavePayload,
} from '../../src/lib/polls/validate';

const NOW = new Date('2026-11-15T12:00:00Z');
const POLL_ID = '11111111-2222-4333-8444-555555555555';
const SECTION_ID = '11111111-2222-4333-8444-000000000001';

type Opt = { id?: string; key?: string; name: string; image_path?: string | null; remove_image?: boolean };
type Sec = { id?: string; key?: string; name: string; answer_type: string; options: Opt[] };

function image(type: string, size: number): File {
  const file = new File(['x'], 'pic', { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function formData(
  sections: Sec[],
  fields: Record<string, string> = {},
  files: Record<string, File> = {},
): FormData {
  const data = new FormData();
  data.set('title', fields.title ?? 'Next season');
  data.set('description', fields.description ?? '');
  data.set('closes_at', fields.closes_at ?? '');
  data.set('updated_at', fields.updated_at ?? '2026-11-15T11:00:00.123456+00:00');
  if (fields.is_schedule_vote) data.set('is_schedule_vote', 'on');
  data.set('structure', JSON.stringify({ sections }));
  for (const [name, file] of Object.entries(files)) data.set(name, file);
  return data;
}

const pickOne = (names = ['Spa', 'Monza'], key = 's1'): Sec => ({
  key,
  name: 'Track',
  answer_type: 'single',
  options: names.map((name, i) => ({ key: `${key}o${i}`, name })),
});

const fields = (errors: { field: string }[]) => errors.map((e) => e.field);

describe('parsePollForm', () => {
  it('accepts a poll with mixed answer types and keeps the loaded updated_at as text', () => {
    const { form, errors } = parsePollForm(
      formData(
        [
          pickOne(),
          { key: 's2', name: 'Rate', answer_type: 'stars', options: [{ key: 's2o0', name: 'Season' }] },
        ],
        {
          is_schedule_vote: 'on',
        },
      ),
      null,
      NOW,
    );
    expect(errors).toEqual([]);
    expect(form.isScheduleVote).toBe(true);
    expect(form.expectedUpdatedAt).toBe('2026-11-15T11:00:00.123456+00:00');
    expect(form.sections.map((s) => s.options.length)).toEqual([2, 1]);
  });

  it('checks the title and description limits (BR1.1)', () => {
    expect(fields(parsePollForm(formData([pickOne()], { title: '   ' }), null, NOW).errors)).toEqual([
      'title',
    ]);
    expect(
      fields(parsePollForm(formData([pickOne()], { title: 't'.repeat(121) }), null, NOW).errors),
    ).toEqual(['title']);
    expect(parsePollForm(formData([pickOne()], { title: ` ${'t'.repeat(120)} ` }), null, NOW).errors).toEqual(
      [],
    );
    expect(
      fields(parsePollForm(formData([pickOne()], { description: 'd'.repeat(2001) }), null, NOW).errors),
    ).toEqual(['description']);
  });

  it('needs 1 to 20 sections, each named and with an answer type (BR1.2)', () => {
    expect(fields(parsePollForm(formData([]), null, NOW).errors)).toEqual(['sections']);
    const many = Array.from({ length: 21 }, (_, i) => pickOne(['A', 'B'], `s${i}`));
    expect(fields(parsePollForm(formData(many), null, NOW).errors)).toContain('sections');
    const unnamed = parsePollForm(formData([{ ...pickOne(), name: ' ' }]), null, NOW).errors;
    expect(unnamed).toEqual([
      { field: 'section:s1', message: 'Section 1: the name must be 1 to 120 characters.' },
    ]);
    expect(
      fields(parsePollForm(formData([{ ...pickOne(), answer_type: 'ranked' }]), null, NOW).errors),
    ).toEqual(['section:s1']);
  });

  it('applies the option counts per answer type (BR1.3)', () => {
    expect(parsePollForm(formData([pickOne(['Only'])]), null, NOW).errors[0].message).toBe(
      'Section 1: Pick one needs 2 to 30 options.',
    );
    const stars: Sec = { key: 's1', name: 'Rate', answer_type: 'stars', options: [] };
    expect(parsePollForm(formData([stars]), null, NOW).errors[0].message).toBe(
      'Section 1: Star rating needs 1 to 30 options.',
    );
    const thirtyOne = Array.from({ length: 31 }, (_, i) => `O${i}`);
    expect(
      fields(parsePollForm(formData([{ ...pickOne(thirtyOne), answer_type: 'multiple' }]), null, NOW).errors),
    ).toEqual(['section:s1']);
  });

  it('refuses option names that repeat ignoring case and spaces, within a section only (BR1.3)', () => {
    const { errors } = parsePollForm(formData([pickOne(['Red', ' red '])]), null, NOW);
    expect(errors).toEqual([
      { field: 'option:s1o1', message: 'Section 1, option 2: "red" is already an option in this section.' },
    ]);
    expect(
      parsePollForm(formData([pickOne(['Red', 'Blue'], 'a'), pickOne(['Red', 'Blue'], 'b')]), null, NOW)
        .errors,
    ).toEqual([]);
  });

  it('counts characters as the database does', () => {
    expect(charLength('\u{1F3C1}ab')).toBe(3);
    const flag = '\u{1F3C1}'.repeat(120);
    expect(parsePollForm(formData([pickOne([flag, 'B'])]), null, NOW).errors).toEqual([]);
  });

  it('wants a future closing date only when it is set or changed (BR2.4)', () => {
    const past = '2026-11-14T12:00:00.000Z';
    expect(parsePollForm(formData([pickOne()], { closes_at: past }), null, NOW).errors).toEqual([
      { field: 'closes_at', message: 'The closing date must be in the future.' },
    ]);
    expect(
      parsePollForm(formData([pickOne()], { closes_at: past }), '2026-11-14T12:00:00+00:00', NOW).errors,
    ).toEqual([]);
    expect(
      parsePollForm(formData([pickOne()], { closes_at: NOW.toISOString() }), null, NOW).errors,
    ).toHaveLength(1);
    expect(parsePollForm(formData([pickOne()], { closes_at: 'soon' }), null, NOW).errors[0].field).toBe(
      'closes_at',
    );
    expect(
      parsePollForm(formData([pickOne()], { closes_at: '2026-11-16T09:30:00.000Z' }), null, NOW).errors,
    ).toEqual([]);
  });

  it('checks image type, size and the per-save count (BR4.1)', () => {
    const gif = parsePollForm(
      formData([pickOne()], {}, { image_s1o0: image('image/gif', 10) }),
      null,
      NOW,
    ).errors;
    expect(gif).toEqual([
      { field: 'option:s1o0', message: 'Section 1, option 1: the image must be a PNG, JPEG or WebP file.' },
    ]);
    const big = parsePollForm(
      formData([pickOne()], {}, { image_s1o1: image('image/png', POLL_IMAGE_MAX_BYTES + 1) }),
      null,
      NOW,
    ).errors;
    expect(big[0].message).toMatch(/5 MB or smaller/);
    expect(
      parsePollForm(
        formData([pickOne()], {}, { image_s1o1: image('image/webp', POLL_IMAGE_MAX_BYTES) }),
        null,
        NOW,
      ).errors,
    ).toEqual([]);

    const names = Array.from({ length: POLL_NEW_IMAGES_MAX + 1 }, (_, i) => `O${i}`);
    const files = Object.fromEntries(names.map((_, i) => [`image_s1o${i}`, image('image/jpeg', 100)]));
    expect(fields(parsePollForm(formData([pickOne(names)], {}, files), null, NOW).errors)).toEqual([
      'images',
    ]);
  });

  it('reads a malformed structure as no sections, and drops ids that are not uuids', () => {
    const data = formData([]);
    data.set('structure', '{not json');
    expect(fields(parsePollForm(data, null, NOW).errors)).toEqual(['sections']);
    const { form } = parsePollForm(formData([{ ...pickOne(), id: 'x; drop' }]), null, NOW);
    expect(form.sections[0].id).toBeNull();
  });
});

describe('pollSavePayload', () => {
  it('trims, nulls an empty description and picks each option image (BR4.2)', () => {
    const { form } = parsePollForm(
      formData(
        [
          {
            id: SECTION_ID,
            key: 's1',
            name: ' Track ',
            answer_type: 'single',
            options: [
              { key: 'a', name: 'Kept', image_path: `${POLL_ID}/a-1.png` },
              { key: 'b', name: 'Removed', image_path: `${POLL_ID}/b-1.png`, remove_image: true },
              { key: 'c', name: 'Replaced', image_path: `${POLL_ID}/c-1.png` },
            ],
          },
        ],
        { title: '  Next  ', description: '   ', closes_at: '2026-11-20T18:00:00.000Z' },
      ),
      null,
      NOW,
    );
    const payload = pollSavePayload(form, new Map([['c', `${POLL_ID}/c-2.webp`]]));
    expect(payload).toEqual({
      title: 'Next',
      description: null,
      closes_at: '2026-11-20T18:00:00.000Z',
      is_schedule_vote: false,
      sections: [
        {
          id: SECTION_ID,
          name: 'Track',
          answer_type: 'single',
          options: [
            { id: null, name: 'Kept', image_path: `${POLL_ID}/a-1.png` },
            { id: null, name: 'Removed', image_path: null },
            { id: null, name: 'Replaced', image_path: `${POLL_ID}/c-2.webp` },
          ],
        },
      ],
    });
  });
});
