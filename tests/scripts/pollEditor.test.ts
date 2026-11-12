/**
 * The poll editor's state helpers (src/scripts/pollEditor.ts; polls BR1.4, BR3.2): add, remove and move
 * sections and options, the hidden structure JSON that parsePollForm reads back, the preview built from unsaved
 * state, and the local date-time conversion. The tests run in UTC.
 */
import { describe, expect, it } from 'vitest';
import {
  actionLabel,
  addOption,
  addSection,
  optionTarget,
  sectionTarget,
  isoToLocal,
  localToIso,
  moveOption,
  moveSection,
  previewView,
  removeOption,
  removeSection,
  structureJson,
} from '../../src/scripts/pollEditor';
import {
  editorStateFromForm,
  editorStateFromPoll,
  newEditorState,
  type EditorState,
} from '../../src/lib/polls/editorState';
import { parsePollForm } from '../../src/lib/polls/validate';
import type { Poll } from '../../src/lib/polls/types';

const POLL_ID = '11111111-2222-4333-8444-555555555555';
const SECTION_ID = '11111111-2222-4333-8444-000000000001';
const OPTION_ID = '11111111-2222-4333-8444-000000000002';
const urlFor = (path: string | null, width: number) => (path ? `/img/${width}/${path}` : null);

function stored(): Poll {
  return {
    id: POLL_ID,
    title: 'Next season',
    description: null,
    closes_at: null,
    is_schedule_vote: false,
    status: 'draft',
    posted_at: null,
    first_posted_at: null,
    created_at: '2026-11-15T11:00:00+00:00',
    updated_at: '2026-11-15T11:00:00.123456+00:00',
    sections: [
      {
        id: SECTION_ID,
        name: 'Track',
        answer_type: 'single',
        position: 0,
        options: [
          { id: OPTION_ID, name: 'Spa', image_path: `${POLL_ID}/spa-1.png`, position: 0 },
          { id: '11111111-2222-4333-8444-000000000003', name: 'Monza', image_path: null, position: 1 },
        ],
      },
    ],
  };
}

const names = (state: EditorState) =>
  state.sections.map((s) => `${s.name}:${s.options.map((o) => o.name).join('|')}`);

describe('editing the structure', () => {
  it('adds sections with two blank options and never reuses a key', () => {
    const state = newEditorState();
    const section = addSection(state);
    const option = addOption(state, section.key)!;
    const keys = state.sections.flatMap((s) => [s.key, ...s.options.map((o) => o.key)]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(section.options).toHaveLength(3);
    expect(section.answer_type).toBe('single');
    expect(option.name).toBe('');
    expect(addOption(state, 'nope')).toBeNull();
  });

  it('moves sections and options up and down, and not past either end', () => {
    const state = editorStateFromPoll(stored(), urlFor);
    const second = addSection(state);
    second.name = 'Cars';
    expect(moveSection(state, second.key, -1)).toBe(true);
    expect(state.sections.map((s) => s.name)).toEqual(['Cars', 'Track']);
    expect(moveSection(state, second.key, -1)).toBe(false);
    const spa = state.sections[1].options[0];
    expect(moveOption(state, spa.key, 1)).toBe(true);
    expect(state.sections[1].options.map((o) => o.name)).toEqual(['Monza', 'Spa']);
    expect(moveOption(state, spa.key, 1)).toBe(false);
  });

  it('removes sections and options', () => {
    const state = editorStateFromPoll(stored(), urlFor);
    removeOption(state, state.sections[0].options[1].key);
    expect(names(state)).toEqual(['Track:Spa']);
    removeSection(state, state.sections[0].key);
    expect(state.sections).toEqual([]);
  });
});

describe('the hidden structure field', () => {
  it('round-trips through parsePollForm in on-screen order, with ids and image choices', () => {
    const state = editorStateFromPoll(stored(), urlFor);
    moveOption(state, state.sections[0].options[1].key, -1);
    state.sections[0].options[1].remove_image = true;
    const data = new FormData();
    data.set('title', 'Next season');
    data.set('structure', structureJson(state));
    const { form, errors } = parsePollForm(data, null);
    expect(errors).toEqual([]);
    expect(form.sections[0].id).toBe(SECTION_ID);
    expect(form.sections[0].options.map((o) => [o.name, o.id, o.removeImage])).toEqual([
      ['Monza', '11111111-2222-4333-8444-000000000003', false],
      ['Spa', OPTION_ID, true],
    ]);
  });

  it('keeps typed text and per-row errors when the form comes back, and drops paths from other folders', () => {
    const data = new FormData();
    data.set('title', 'T');
    data.set(
      'structure',
      JSON.stringify({
        sections: [
          {
            key: 'k7',
            name: '',
            answer_type: 'single',
            options: [
              { key: 'k8', name: 'A', image_path: `${POLL_ID}/a-1.png` },
              { key: 'k9', name: 'B', image_path: '99999999-2222-4333-8444-555555555555/b-1.png' },
            ],
          },
        ],
      }),
    );
    const { form, errors } = parsePollForm(data, null);
    const state = editorStateFromForm(form, POLL_ID, errors, urlFor);
    expect(state.sections[0].error).toBe('Section 1: the name must be 1 to 120 characters.');
    expect(state.sections[0].options.map((o) => o.image_path)).toEqual([`${POLL_ID}/a-1.png`, null]);
    expect(state.next_key).toBe(10);
  });
});

describe('previewView (BR3.2)', () => {
  it('draws the unsaved state: local files, removed images and the stored image at preview size', () => {
    const state = editorStateFromPoll(stored(), urlFor);
    const added = addSection(state);
    added.answer_type = 'stars';
    added.name = 'Rate';
    added.options[0].name = 'Season';
    const view = previewView(
      state,
      '  Draft title ',
      '',
      new Map([[state.sections[0].options[1].key, 'blob:local-1']]),
    );
    expect(view.title).toBe('Draft title');
    expect(view.description).toBeNull();
    expect(view.sections[0].options.map((o) => o.imageUrl)).toEqual([
      `/img/320/${POLL_ID}/spa-1.png`,
      'blob:local-1',
    ]);
    expect(view.sections[1].answerType).toBe('stars');
    expect(view.sections[1].options.map((o) => o.name)).toEqual(['Season', 'Untitled option']);

    state.sections[0].options[0].remove_image = true;
    expect(previewView(state, 'T', '', new Map()).sections[0].options[0].imageUrl).toBeNull();
  });

  it('fills blank names so the preview never shows an empty heading', () => {
    const view = previewView(newEditorState(), ' ', ' ', new Map());
    expect(view.title).toBe('Untitled poll');
    expect(view.sections[0].name).toBe('Untitled section');
  });
});

describe('closing date conversion', () => {
  it('turns an instant into a datetime-local value and back (UTC here)', () => {
    expect(isoToLocal('2026-11-20T18:30:00+00:00')).toBe('2026-11-20T18:30');
    expect(localToIso('2026-11-20T18:30')).toBe('2026-11-20T18:30:00.000Z');
    expect(isoToLocal('')).toBe('');
    expect(localToIso('')).toBe('');
    expect(localToIso('not a date')).toBe('');
  });
});

describe('icon button names (FR8.2, BR8.1)', () => {
  it('names the section or option each button acts on', () => {
    expect(actionLabel('section-up', sectionTarget('', 1))).toBe('Move Section 2 up');
    expect(actionLabel('section-down', sectionTarget('Format', 0))).toBe('Move section Format down');
    expect(actionLabel('remove-section', sectionTarget('', 0))).toBe('Remove Section 1');
    expect(actionLabel('add-option', sectionTarget('Format', 0))).toBe('Add option to section Format');
    expect(actionLabel('remove-option', optionTarget(' Red ', 0))).toBe('Remove option Red');
    expect(actionLabel('option-up', optionTarget('', 2))).toBe('Move Option 3 up');
    expect(actionLabel('option-down', optionTarget('Blue', 1))).toBe('Move option Blue down');
  });
});
