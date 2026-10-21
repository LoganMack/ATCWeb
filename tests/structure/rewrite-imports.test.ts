/**
 * The importer rewrite used by every library split (functional spec Delivery item 3; FR4.2):
 * scripts/rewrite-imports.mjs points each named import of a split file at its defining module.
 */
import { describe, expect, it } from 'vitest';
import { applyEdits, planFile } from '../../scripts/rewrite-imports.mjs';

const MAP = {
  original: 'src/lib/thing.ts',
  modules: {
    alpha: 'src/lib/thing/a.ts',
    Alpha: 'src/lib/thing/a.ts',
    beta: 'src/lib/thing/b.ts',
    Beta: 'src/lib/thing/b.ts',
  },
};

function rewrite(file: string, text: string) {
  const plan = planFile(file, text, MAP);
  return { text: applyEdits(text, plan.edits), problems: plan.problems };
}

describe('rewrite-imports', () => {
  it('splits one import into one per defining module, keeping aliases and inline types', () => {
    const out = rewrite(
      'src/lib/user.ts',
      "import { alpha, beta as b, type Alpha } from './thing';\nalpha();\n",
    );
    expect(out.problems).toEqual([]);
    expect(out.text).toBe(
      "import { alpha, type Alpha } from './thing/a';\nimport { beta as b } from './thing/b';\nalpha();\n",
    );
  });

  it('keeps `import type` type-only and turns an all-inline-type group into `import type`', () => {
    const out = rewrite(
      'tests/lib/user.test.ts',
      "import type { Alpha, Beta } from '../../src/lib/thing';\nimport { alpha, type Beta as B } from '../../src/lib/thing';\n",
    );
    expect(out.text).toBe(
      "import type { Alpha } from '../../src/lib/thing/a';\n" +
        "import type { Beta } from '../../src/lib/thing/b';\n" +
        "import { alpha } from '../../src/lib/thing/a';\n" +
        "import type { Beta as B } from '../../src/lib/thing/b';\n",
    );
  });

  it('rewrites only the frontmatter imports of an .astro page, keeping CRLF line endings', () => {
    const page =
      "---\r\nimport { beta } from '../lib/thing';\r\nimport { other } from '../lib/other';\r\n---\r\n<p>{beta()}</p>\r\n";
    expect(rewrite('src/pages/p.astro', page).text).toBe(
      "---\r\nimport { beta } from '../lib/thing/b';\r\nimport { other } from '../lib/other';\r\n---\r\n<p>{beta()}</p>\r\n",
    );
  });

  it('wraps a statement that would pass 110 characters', () => {
    const map = {
      original: 'src/lib/thing.ts',
      modules: {
        aVeryLongExportedFunctionName: 'src/lib/thing/a.ts',
        anotherVeryLongExportedFunctionName: 'src/lib/thing/a.ts',
        yetAnotherName: 'src/lib/thing/a.ts',
      },
    };
    const text =
      "import { aVeryLongExportedFunctionName, anotherVeryLongExportedFunctionName, yetAnotherName } from './thing';\n";
    const plan = planFile('src/lib/user.ts', text, map);
    expect(applyEdits(text, plan.edits)).toBe(
      "import {\n  aVeryLongExportedFunctionName,\n  anotherVeryLongExportedFunctionName,\n  yetAnotherName,\n} from './thing/a';\n",
    );
  });

  it('refuses imports it cannot split by name, and names missing from the map', () => {
    expect(rewrite('src/lib/user.ts', "import * as thing from './thing';").problems).toHaveLength(1);
    expect(rewrite('src/lib/user.ts', "import { gamma } from './thing';").problems[0]).toMatch(
      /gamma is not in the module map/,
    );
    expect(rewrite('tests/x.test.ts', "vi.mock('../src/lib/thing');").problems).toHaveLength(1);
  });

  it('leaves imports of other modules alone', () => {
    const text = "import { alpha } from './thing/a';\nimport { x } from './thingamajig';\n";
    expect(planFile('src/lib/user.ts', text, MAP).edits).toEqual([]);
  });
});
