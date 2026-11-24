/**
 * The circuit editor's form parsing (src/lib/circuitEditorForm.ts; circuit-editor BR1.4 to BR1.8, BR1.16 to
 * BR1.19, NFR7.1, NFR7.3): every refusal happens before a write and keeps what was typed, a plate is written
 * only when it changed, and a layout write never carries a lap record.
 */
import { describe, expect, it } from 'vitest';
import {
  CIRCUIT_EDITOR_MESSAGES,
  emptyLayoutFormState,
  layoutFormStateFor,
  layoutSaveOutcome,
  parseCircuitForm,
  parseLayoutForm,
  parseLogoBackgroundChoice,
} from '../../src/lib/circuitEditorForm';
import type { CircuitLayout } from '../../src/lib/db/circuits';

function formOf(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

const circuit = (fields: Record<string, string> = {}) =>
  formOf({
    intent: 'save',
    name: 'Spa',
    location: 'Belgium',
    latitude: '',
    longitude: '',
    had_coords: '0',
    logo_background: '',
    logo_background_hex: '',
    had_logo_background: '',
    ...fields,
  });

const layout = (fields: Record<string, string> = {}) =>
  formOf({
    intent: 'add-layout',
    layout_name: 'Grand Prix',
    category: 'road_long',
    length_km: '7.004',
    corners: '19',
    ...fields,
  });

const row: CircuitLayout = {
  id: 'l-1',
  circuit_id: 'c-1',
  name: 'Grand Prix',
  length_km: 7.004,
  lap_record_seconds: null,
  lap_record_holder: null,
  lap_record_date: null,
  image_url: null,
  corners: 19,
  category: null,
};

describe('parseLogoBackgroundChoice', () => {
  it('reads None, Light and Dark, and treats an unknown mode as None', () => {
    expect(parseLogoBackgroundChoice('', '')).toEqual({ mode: 'none', text: '', value: null });
    expect(parseLogoBackgroundChoice('light', '')).toEqual({ mode: 'light', text: '', value: 'light' });
    expect(parseLogoBackgroundChoice('dark', 'x')).toEqual({ mode: 'dark', text: 'x', value: 'dark' });
    expect(parseLogoBackgroundChoice('purple', '')).toEqual({ mode: 'none', text: '', value: null });
  });

  it('leaves value out for an invalid custom colour, keeping the text', () => {
    expect(parseLogoBackgroundChoice('custom', 'red')).toEqual({ mode: 'custom', text: 'red' });
  });
});

describe('parseCircuitForm: logo colour (AC5.2.3, AC5.2.4, NFR7.1)', () => {
  it.each([
    ['rgb(67, 105, 245)', '#4369f5'],
    ['#4369F5', '#4369f5'],
    ['#46F', '#4466ff'],
  ])('normalises %s to %s', (typed, stored) => {
    const result = parseCircuitForm(circuit({ logo_background: 'custom', logo_background_hex: typed }));
    expect(result.error).toBeNull();
    expect(result.write?.logoBackground).toBe(stored);
  });

  it.each(['red', '#4369f5;}', 'expression(1)', ''])('refuses %j with no write and the text kept', (typed) => {
    const result = parseCircuitForm(circuit({ logo_background: 'custom', logo_background_hex: typed }));
    expect(result.error).toBe(CIRCUIT_EDITOR_MESSAGES.logoBackground);
    expect(result.write).toBeUndefined();
    expect(result.state.logoBackgroundMode).toBe('custom');
    expect(result.state.logoBackgroundText).toBe(typed);
  });
});

describe('parseCircuitForm: written only when changed (BR1.8)', () => {
  it('sends no logoBackground for the same colour in another form', () => {
    const result = parseCircuitForm(
      circuit({ logo_background: 'custom', logo_background_hex: '#4369F5', had_logo_background: '#4369f5' }),
    );
    expect(result.write).toBeDefined();
    expect('logoBackground' in result.write!).toBe(false);
  });

  it('sends Light when nothing was stored, and null when None replaces a stored plate', () => {
    expect(parseCircuitForm(circuit({ logo_background: 'light' })).write?.logoBackground).toBe('light');
    const cleared = parseCircuitForm(circuit({ logo_background: '', had_logo_background: '#4369f5' }));
    expect(cleared.write && 'logoBackground' in cleared.write).toBe(true);
    expect(cleared.write?.logoBackground).toBeNull();
  });

  it('sends nothing for an unknown mode when nothing was stored', () => {
    const result = parseCircuitForm(circuit({ logo_background: 'sparkly' }));
    expect(result.write && 'logoBackground' in result.write).toBe(false);
  });
});

describe('parseCircuitForm: order and state', () => {
  it('refuses an empty name and keeps every typed field', () => {
    const result = parseCircuitForm(
      circuit({ name: '  ', location: 'Here', latitude: '50.4', logo_background: 'custom', logo_background_hex: '#abc' }),
    );
    expect(result.error).toBe(CIRCUIT_EDITOR_MESSAGES.nameRequired);
    expect(result.write).toBeUndefined();
    expect(result.state).toEqual({
      name: '  ',
      location: 'Here',
      latitude: '50.4',
      longitude: '',
      logoBackgroundMode: 'custom',
      logoBackgroundText: '#abc',
    });
  });

  it('refuses bad coordinates with the existing message', () => {
    const result = parseCircuitForm(circuit({ latitude: '91', longitude: '5' }));
    expect(result.error).toBe(CIRCUIT_EDITOR_MESSAGES.coordinates);
    expect(result.state.latitude).toBe('91');
  });

  it('reports the first error in order when two are wrong', () => {
    const result = parseCircuitForm(
      circuit({ latitude: 'x', logo_background: 'custom', logo_background_hex: 'red' }),
    );
    expect(result.error).toBe(CIRCUIT_EDITOR_MESSAGES.coordinates);
  });

  it('sets, clears or leaves the coordinates alone', () => {
    expect(parseCircuitForm(circuit({ latitude: '50.4', longitude: '5.9' })).write?.coords).toEqual({
      latitude: 50.4,
      longitude: 5.9,
    });
    expect(parseCircuitForm(circuit({ had_coords: '1' })).write?.coords).toEqual({
      latitude: null,
      longitude: null,
    });
    expect(parseCircuitForm(circuit()).write).toEqual({ name: 'Spa', location: 'Belgium', coords: null });
  });
});

describe('parseLayoutForm (BR1.16, BR1.18, NFR7.3)', () => {
  it('refuses a missing or unknown category', () => {
    for (const category of ['', 'gravel']) {
      const { state, write } = parseLayoutForm(layout({ category }));
      expect(write).toBeUndefined();
      expect(state.error).toEqual({ field: 'category', message: CIRCUIT_EDITOR_MESSAGES.categoryRequired });
    }
    const noField = formOf({ intent: 'add-layout', layout_name: 'GP' });
    expect(parseLayoutForm(noField).state.error?.field).toBe('category');
  });

  it('refuses an empty name first', () => {
    const { state } = parseLayoutForm(layout({ layout_name: ' ', category: '' }));
    expect(state.error).toEqual({ field: 'layout_name', message: CIRCUIT_EDITOR_MESSAGES.layoutNameRequired });
  });

  it('accepts corners 0 and 200 and refuses 201 and 1.5', () => {
    expect(parseLayoutForm(layout({ corners: '0' })).write?.corners).toBe(0);
    expect(parseLayoutForm(layout({ corners: '200' })).write?.corners).toBe(200);
    for (const corners of ['201', '1.5', '-1', '1e2', '0x10']) {
      expect(parseLayoutForm(layout({ corners })).state.error).toEqual({
        field: 'corners',
        message: CIRCUIT_EDITOR_MESSAGES.corners,
      });
    }
  });

  it('accepts length 100 and refuses 0, 100.01 and abc', () => {
    expect(parseLayoutForm(layout({ length_km: '100' })).write?.length_km).toBe(100);
    expect(parseLayoutForm(layout({ length_km: '4.023' })).write?.length_km).toBe(4.023);
    for (const length_km of ['0', '100.01', 'abc', '1e-9', '0x10', '0.0004', '-2']) {
      const { state, write } = parseLayoutForm(layout({ length_km }));
      expect(write).toBeUndefined();
      expect(state.error).toEqual({ field: 'length_km', message: CIRCUIT_EDITOR_MESSAGES.lengthKm });
    }
  });

  it('turns empty length and corners into null', () => {
    const { write } = parseLayoutForm(layout({ length_km: '', corners: ' ' }));
    expect(write).toEqual({ name: 'Grand Prix', category: 'road_long', length_km: null, corners: null });
  });

  it('never writes a lap record, whatever is posted (BR1.17)', () => {
    const { write } = parseLayoutForm(
      layout({ lap_record_seconds: '102.5', lap_record_holder: 'A. Driver', lap_record_date: '2026-01-01' }),
    );
    expect(Object.keys(write!).sort()).toEqual(['category', 'corners', 'length_km', 'name']);
  });

  it('keeps the typed values and the layout id as the dialog key on a refused update (BR1.19)', () => {
    const { state } = parseLayoutForm(
      layout({ intent: 'update-layout', layout_id: 'l-9', corners: '1.5', length_km: '4.2 ' }),
    );
    expect(state.dialogKey).toBe('l-9');
    expect(state.corners).toBe('1.5');
    expect(state.lengthKm).toBe('4.2 ');
    expect(parseLayoutForm(layout({ corners: 'x' })).state.dialogKey).toBe('new');
  });
});

describe('layout dialog states', () => {
  it('fills from a stored layout, with a null category as empty', () => {
    expect(layoutFormStateFor(row)).toEqual({
      dialogKey: 'l-1',
      name: 'Grand Prix',
      category: '',
      lengthKm: '7.004',
      corners: '19',
      error: null,
    });
  });

  it('starts empty for a new layout', () => {
    expect(emptyLayoutFormState()).toEqual({
      dialogKey: 'new',
      name: '',
      category: '',
      lengthKm: '',
      corners: '',
      error: null,
    });
  });
});

describe('layoutSaveOutcome', () => {
  it('accepts a saved row and refuses a PATCH that matched nothing', () => {
    expect(layoutSaveOutcome(row)).toEqual({ ok: true });
    expect(layoutSaveOutcome(undefined)).toEqual({ ok: false, error: 'This layout no longer exists.' });
  });
});
