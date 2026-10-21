/**
 * No value-import cycles under src/lib (functional spec W5.2; BR1.4). Type-only imports, both
 * `import type { … }` and inline `type` specifiers, vanish at build time and don't count.
 */
import { describe, expect, it } from 'vitest';
import { findCycles } from '../../scripts/import-cycles.mjs';

// Bundled by Vite's glob import, so the test needs no Node file-system access.
const LIB = import.meta.glob('/src/lib/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

describe('import cycles in src/lib (W5.2, BR1.4)', () => {
  it('reads the library, including the split modules', () => {
    expect(Object.keys(LIB)).toContain('/src/lib/penalties/roundResults.ts');
  });

  it('has no value-import cycle', () => {
    expect(findCycles(LIB)).toEqual([]);
  });
});

describe('the cycle check itself', () => {
  it('reports a value-import cycle as the path around it', () => {
    const files = {
      'src/lib/a.ts': "import { b } from './b';",
      'src/lib/b.ts': "import { c } from './c';",
      'src/lib/c.ts': "import { a } from './a';",
    };
    expect(findCycles(files)).toEqual([['src/lib/a.ts', 'src/lib/b.ts', 'src/lib/c.ts', 'src/lib/a.ts']]);
  });

  it('ignores `import type` and imports made only of inline type specifiers', () => {
    expect(
      findCycles({
        'src/lib/a.ts': "import { b } from './b';",
        'src/lib/b.ts': "import type { A } from './a';\nexport type { A as Again } from './a';",
      }),
    ).toEqual([]);
    expect(
      findCycles({
        'src/lib/a.ts': "import { b } from './b';",
        'src/lib/b.ts': "import { type A } from './a';",
      }),
    ).toEqual([]);
  });

  it('counts an import that mixes a value with inline types, a re-export and a side-effect import', () => {
    expect(
      findCycles({
        'src/lib/a.ts': "import { b } from './b';",
        'src/lib/b.ts': "import { type A, a } from './a';",
      }),
    ).toHaveLength(1);
    expect(
      findCycles({ 'src/lib/a.ts': "import { b } from './b';", 'src/lib/b.ts': "export { a } from './a';" }),
    ).toHaveLength(1);
    expect(
      findCycles({ 'src/lib/a.ts': "import { b } from './b';", 'src/lib/b.ts': "import './a';" }),
    ).toHaveLength(1);
  });

  it('resolves folder modules and ignores packages', () => {
    expect(
      findCycles({
        'src/lib/x/index.ts': "import { y } from '../y';\nimport ts from 'typescript';",
        'src/lib/y.ts': "import { x } from './x';",
      }),
    ).toEqual([['src/lib/x/index.ts', 'src/lib/y.ts', 'src/lib/x/index.ts']]);
  });
});
