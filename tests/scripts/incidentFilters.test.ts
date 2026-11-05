/**
 * The Reported Incidents filter switch (FR1.2, FR1.7; BR1.5): clicking a filter shows only its cards, presses its
 * button, shows its empty line when it has nothing, and empties any player built in a card it hides. Vitest
 * runs in Node, so the cards are small fakes.
 */
import { describe, expect, it } from 'vitest';
import { applyFilter, type FilterItem } from '../../src/scripts/incidentFilters';

function card(group: string) {
  const state = { hidden: false, cleared: 0 };
  const item: FilterItem = {
    group,
    setHidden: (hidden) => (state.hidden = hidden),
    clearPlayer: () => (state.cleared += 1),
  };
  return { item, state };
}

function button(filter: string) {
  const state = { pressed: false };
  return { button: { filter, setPressed: (p: boolean) => (state.pressed = p) }, state };
}

function emptyLine(filter: string) {
  const state = { hidden: true };
  return { line: { filter, setHidden: (h: boolean) => (state.hidden = h) }, state };
}

const FILTERS = ['needs_review', 'reviewed', 'decided', 'dismissed', 'appeals'];

describe('applyFilter', () => {
  it('shows only the chosen filter’s cards and presses only its button', () => {
    const cards = [card('needs_review'), card('reviewed'), card('reviewed'), card('appeals')];
    const buttons = FILTERS.map(button);
    const empties = FILTERS.map(emptyLine);
    applyFilter(
      'reviewed',
      cards.map((c) => c.item),
      buttons.map((b) => b.button),
      empties.map((e) => e.line),
    );
    expect(cards.map((c) => c.state.hidden)).toEqual([true, false, false, true]);
    expect(buttons.map((b) => b.state.pressed)).toEqual([false, true, false, false, false]);
    expect(empties.every((e) => e.state.hidden)).toBe(true);
  });

  it('empties the players of the cards it hides, never of the ones it shows', () => {
    const cards = [card('needs_review'), card('decided')];
    applyFilter(
      'decided',
      cards.map((c) => c.item),
      [],
      [],
    );
    expect(cards[0].state.cleared).toBe(1);
    expect(cards[1].state.cleared).toBe(0);
  });

  it('shows the empty line of a filter with nothing in it, and only that one', () => {
    const cards = [card('needs_review')];
    const empties = FILTERS.map(emptyLine);
    applyFilter(
      'dismissed',
      cards.map((c) => c.item),
      [],
      empties.map((e) => e.line),
    );
    expect(cards[0].state.hidden).toBe(true);
    expect(empties.map((e) => e.state.hidden)).toEqual([true, true, true, false, true]);
  });
});
