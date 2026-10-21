import { beforeAll, describe, expect, it } from 'vitest';
import {
  canon,
  compareThemes,
  formatDifferences,
  lightRuleViolations,
  loadBeforeCss,
  runProof,
  swapProblems,
  tokensEqual,
} from '../../scripts/theme-proof.mjs';

// Compiling the site's CSS and walking every class list takes a few seconds.
const SLOW = 180_000;

describe('theme colours: compiled proof (spec W3.1)', () => {
  let result: Awaited<ReturnType<typeof runProof>>;

  beforeAll(async () => {
    result = await runProof();
  }, SLOW);

  it('checks every class list in the markup, in both themes and every implied state', () => {
    expect(result.elements).toBeGreaterThan(1000);
    expect(result.checked).toBeGreaterThan(result.elements * 4);
  });

  it('resolves every colour to the same value as before the change (BR2.3)', () => {
    expect(result.differences.length, formatDifferences(result.differences)).toBe(0);
  });

  it('leaves only custom properties and color-scheme under .light (BR2.2)', () => {
    expect(result.lightViolations).toEqual([]);
  });

  it('applies every fixed-family swap the inventory requires, as listed in swaps.json', async () => {
    expect(await swapProblems()).toEqual([]);
  });
});

describe('theme colours: the proof itself', () => {
  it('treats float drift within 0.002 as equal and a one-step channel change as different', () => {
    const boosted = canon('rgb(17 17 20 / min(1, calc(0.2 + 0.08)))', null);
    expect(tokensEqual(boosted, canon('rgb(17 17 20 / 0.28)', null))).toBe(true);
    expect(tokensEqual(canon('rgba(17, 17, 20, 0.28)', null), canon('rgb(17 17 20 / 0.28)', null))).toBe(
      true,
    );
    expect(tokensEqual(canon('#4369f5', null), canon('rgb(66 104 245)', null))).toBe(false);
    expect(tokensEqual(canon('rgb(17 17 20 / 0.28)', null), canon('rgb(17 17 20 / 0.3)', null))).toBe(false);
  });

  it('reports a .light rule that sets anything but a custom property or color-scheme', () => {
    const css =
      '.light { color-scheme: light; --fg: 17 17 20 } .light .x { --y: 1 } .light .z { color: red }';
    expect(lightRuleViolations(css)).toEqual(['.light .z { color: red }']);
  });

  it(
    'fails when a single light-theme colour changes',
    async () => {
      const before = await loadBeforeCss();
      // One light-theme text colour, as frozen in before.css (line endings vary by checkout).
      const rule = /(\.light \.text-white\\\/60 \{\s*color: rgb\(17 17 20 \/ )0\.68(\);\s*\})/;
      expect(before).toMatch(rule);
      const changed = before.replace(rule, '$10.6$2');
      const { differences } = await compareThemes({ beforeCss: before, afterCss: changed, swaps: [] });
      expect(differences.length).toBeGreaterThan(0);
      // Only light mode moves: `color` itself, plus anything drawn in currentColor.
      expect(differences.every((d) => d.theme === 'light')).toBe(true);
      expect(differences.some((d) => d.prop === 'color' && /text-white\/60/.test(d.element))).toBe(true);
    },
    SLOW,
  );
});
