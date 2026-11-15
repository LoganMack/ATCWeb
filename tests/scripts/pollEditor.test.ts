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
  DUPLICATE_LAYOUT_MESSAGE,
  duplicateLayoutKeys,
  effectiveName,
  modeToggleLabels,
  optionTarget,
  pickLayout,
  setOptionMode,
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
import type { LayoutChoice, Poll } from '../../src/lib/polls/types';

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
        text_max_length: null,
        position: 0,
        options: [
          { id: OPTION_ID, name: 'Spa', image_path: `${POLL_ID}/spa-1.png`, layout_id: null, position: 0 },
          {
            id: '11111111-2222-4333-8444-000000000003',
            name: 'Monza',
            image_path: null,
            layout_id: null,
            position: 1,
          },
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

const LAYOUT_SPA = '11111111-2222-4333-8444-0000000000a1';
const LAYOUT_MONZA = '11111111-2222-4333-8444-0000000000a2';
const SPA: LayoutChoice = { id: LAYOUT_SPA, label: 'Spa — Grand Prix', imageUrl: '/layouts/spa.png' };
const MONZA: LayoutChoice = { id: LAYOUT_MONZA, label: 'Monza', imageUrl: null };

describe('Circuits and Text option rows (BR6.1-BR6.6)', () => {
  it('opens a saved row with a layout in Circuits mode and any other saved row in Text mode (BR6.5)', () => {
    const poll = stored();
    poll.sections[0].options[1] = { ...poll.sections[0].options[1], name: 'Monza', layout_id: LAYOUT_MONZA };
    const state = editorStateFromPoll(poll, urlFor);
    const [spa, monza] = state.sections[0].options;
    expect([spa.mode, spa.layout_id, spa.name]).toEqual(['text', null, 'Spa']);
    expect([monza.mode, monza.layout_id, monza.layout_name]).toEqual(['circuits', LAYOUT_MONZA, 'Monza']);
    expect(effectiveName(monza)).toBe('Monza');
  });

  it('starts a new row in Circuits mode and switches between the modes without losing either value', () => {
    const state = newEditorState();
    const option = state.sections[0].options[0];
    expect(option.mode).toBe('circuits');
    pickLayout(state, option.key, SPA);
    expect(setOptionMode(state, option.key, 'text')).toBe(true);
    option.name = 'Typed';
    expect(effectiveName(option)).toBe('Typed');
    setOptionMode(state, option.key, 'circuits');
    expect(effectiveName(option)).toBe('Spa — Grand Prix');
    expect(setOptionMode(state, 'nope', 'text')).toBe(false);
  });

  it('names the toggle after what pressing it does, with aria-pressed true in Circuits mode', () => {
    expect(modeToggleLabels('circuits')).toMatchObject({ label: 'Use text', pressed: 'true' });
    expect(modeToggleLabels('text')).toMatchObject({ label: 'Use circuit', pressed: 'false' });
  });

  it('picking a layout sets the name from its label and keeps a stored upload for switching back', () => {
    const state = editorStateFromPoll(stored(), urlFor);
    const spa = state.sections[0].options[0];
    const storedPath = spa.image_path;
    expect(pickLayout(state, spa.key, SPA)).toBe(true);
    expect([spa.mode, spa.layout_id, spa.layout_name, spa.remove_image]).toEqual([
      'circuits',
      LAYOUT_SPA,
      'Spa — Grand Prix',
      false,
    ]);
    setOptionMode(state, spa.key, 'text');
    expect([spa.mode, spa.image_path, spa.remove_image]).toEqual(['text', storedPath, false]);
    pickLayout(state, spa.key, null);
    expect([spa.layout_id, spa.layout_name]).toEqual([null, '']);
  });

  it('flags only the later rows that repeat a layout in the same section', () => {
    const state = newEditorState();
    const section = state.sections[0];
    const third = addOption(state, section.key)!;
    pickLayout(state, section.options[0].key, SPA);
    pickLayout(state, section.options[1].key, MONZA);
    pickLayout(state, third.key, SPA);
    expect([...duplicateLayoutKeys(section)]).toEqual([third.key]);
    setOptionMode(state, third.key, 'text');
    expect(duplicateLayoutKeys(section).size).toBe(0);
    expect(DUPLICATE_LAYOUT_MESSAGE).toBe('This circuit is already an option in this section.');
  });

  it('sends the mode, layout and max length in the structure field, and a Circuits row sends no image', () => {
    const state = editorStateFromPoll(stored(), urlFor);
    const [spa] = state.sections[0].options;
    pickLayout(state, spa.key, SPA);
    const text = addSection(state);
    text.name = 'Ideas';
    text.answer_type = 'text';
    text.text_max_length = '50';
    const data = new FormData();
    data.set('title', 'Next season');
    data.set('structure', structureJson(state));
    const { form, errors } = parsePollForm(data, null);
    expect(errors).toEqual([]);
    expect(form.sections[0].options[0]).toMatchObject({
      name: 'Spa — Grand Prix',
      mode: 'circuits',
      layoutId: LAYOUT_SPA,
    });
    expect(form.sections[1]).toMatchObject({ answerType: 'text', textMaxLength: '50' });
  });

  it('previews a Circuits row with its layout image and a Text question with its max length and no options', () => {
    const state = newEditorState();
    const section = state.sections[0];
    section.name = 'Track';
    pickLayout(state, section.options[0].key, SPA);
    pickLayout(state, section.options[1].key, MONZA);
    const text = addSection(state);
    text.answer_type = 'text';
    text.text_max_length = '80';
    const view = previewView(
      state,
      'T',
      '',
      new Map(),
      new Map([
        [LAYOUT_SPA, '/layouts/spa.png'],
        [LAYOUT_MONZA, null],
      ]),
    );
    expect(view.sections[0].options).toEqual([
      { name: 'Spa — Grand Prix', imageUrl: '/layouts/spa.png' },
      { name: 'Monza', imageUrl: null },
    ]);
    expect(view.sections[1]).toMatchObject({ answerType: 'text', maxLength: 80, options: [] });
    text.text_max_length = '9999';
    expect(previewView(state, 'T', '', new Map()).sections[1].maxLength).toBe(200);
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
