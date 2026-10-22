/**
 * FR6 (BR3.1, BR3.2): standings compute functions only read the season context, so one context can be
 * shared by every view. The freeze runs cover the pure builders the ATC17 golden data supports; the
 * static scan covers the rest of the results code, which fetches and so cannot run here.
 */
import { describe, expect, it } from 'vitest';
import type { SeasonOverallContext } from '../../src/lib/results/seasonContext';
import { buildContext, expected, inputs, standingsFor, wanted, type GoldenRow } from '../golden/atc17';

// ---------------------------------------------------------------------------------------------------
// Deep freeze
// ---------------------------------------------------------------------------------------------------

const MUTATORS = ['set', 'add', 'delete', 'clear'] as const;

/**
 * Freezes every object and array reachable from `value`, and replaces the mutators of every Map and
 * Set with functions that throw, because Object.freeze does not stop Map.set or Set.add.
 */
function deepFreeze<T>(value: T, path = 'context', seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      deepFreeze(key, `${path} key`, seen);
      deepFreeze(entry, `${path}.get(${String(key)})`, seen);
    }
  } else if (value instanceof Set) {
    for (const entry of value) deepFreeze(entry, `${path} entry`, seen);
  }
  if (value instanceof Map || value instanceof Set) {
    for (const name of MUTATORS) {
      if (typeof (value as unknown as Record<string, unknown>)[name] !== 'function') continue;
      Object.defineProperty(value, name, {
        value: () => {
          throw new TypeError(`${path}.${name}() called on the read-only season context`);
        },
      });
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], `${path}.${String(key)}`, seen);
  }
  return Object.freeze(value);
}

/** A frozen ATC17 context. Cloned first so freezing never reaches the shared golden inputs. */
function frozenContext(): SeasonOverallContext {
  return deepFreeze(structuredClone(buildContext()));
}

function goldenRows(classId: number | null, context: SeasonOverallContext): GoldenRow[] {
  return standingsFor(classId, context).map((s) => ({
    position: s.position,
    driverId: s.driver.id,
    total: s.totalPoints,
  }));
}

const classIds = inputs.classes.map((c) => c.id);
const views: { name: string; classId: number | null }[] = [
  { name: 'overall', classId: null },
  ...inputs.classes.map((c) => ({ name: c.name, classId: c.id })),
];

describe('deepFreeze', () => {
  const sample = () =>
    deepFreeze({
      // Two rows out of order: V8 lets a sort that has nothing to move pass on a frozen array.
      rows: [{ points: 1 }, { points: 3 }],
      byKey: new Map([['a', [1, 2]]]),
      ids: new Set([1]),
    });

  it('blocks Map and Set mutators', () => {
    const frozen = sample();
    expect(() => frozen.byKey.set('b', [])).toThrow(/context\.byKey\.set\(\)/);
    expect(() => frozen.byKey.delete('a')).toThrow(TypeError);
    expect(() => frozen.byKey.clear()).toThrow(TypeError);
    expect(() => frozen.ids.add(2)).toThrow(TypeError);
    expect(() => frozen.ids.delete(1)).toThrow(TypeError);
    expect(frozen.byKey.get('a')).toEqual([1, 2]);
  });

  it('blocks in-place array changes, including arrays inside a Map', () => {
    const frozen = sample();
    expect(() => frozen.rows.sort((a, b) => b.points - a.points)).toThrow(TypeError);
    expect(() => frozen.rows.push({ points: 2 })).toThrow(TypeError);
    expect(() => frozen.byKey.get('a')!.reverse()).toThrow(TypeError);
  });

  it('blocks property assignment on nested objects', () => {
    const frozen = sample();
    expect(() => {
      frozen.rows[0].points = 5;
    }).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------------------------------
// FR6.1: the pure builders run on a frozen context
// ---------------------------------------------------------------------------------------------------

describe('pure standings builders on a frozen ATC17 context', () => {
  it('covers the overall view and all three classes', () => {
    expect(classIds).toEqual([1, 2, 3]);
    expect(views.map((v) => v.name)).toEqual(['overall', 'Alpha', 'Gamma', 'Delta']);
  });

  it.each(views)(
    '$name does not write to the context and still matches the live page',
    ({ name, classId }) => {
      const context = frozenContext();
      let rows: GoldenRow[] = [];
      expect(() => {
        rows = goldenRows(classId, context);
      }).not.toThrow();
      expect(rows).toEqual(expected.views[name].rows.map((r) => wanted(name, r)));
    },
  );

  it('all four views run back to back on one frozen context', () => {
    const context = frozenContext();
    const counts = views.map((v) => goldenRows(v.classId, context).length);
    // Row counts of the captured ATC17 pages: overall 62, Alpha 9, Gamma 16, Delta 37.
    expect(counts).toEqual([62, 9, 16, 37]);
  });
});

// ---------------------------------------------------------------------------------------------------
// FR6.2: sharing one context gives the same answers as a context per view
// ---------------------------------------------------------------------------------------------------

describe('one shared context versus a context per view', () => {
  it('gives deep-equal standings for every view, in either order', () => {
    const shared = buildContext();
    const sharedForward = views.map((v) => standingsFor(v.classId, shared));
    const sharedBackward = [...views]
      .reverse()
      .map((v) => standingsFor(v.classId, shared))
      .reverse();
    const separate = views.map((v) => standingsFor(v.classId, buildContext()));

    expect(sharedForward).toEqual(separate);
    expect(sharedBackward).toEqual(separate);
  });

  it('leaves the shared context equal to a fresh one after every view has run', () => {
    const shared = buildContext();
    for (const v of views) standingsFor(v.classId, shared);
    expect(shared).toEqual(buildContext());
  });
});

// ---------------------------------------------------------------------------------------------------
// FR6.1: static scan of the results code for writes through a context value
// ---------------------------------------------------------------------------------------------------

const CONTEXT_NAMES = ['overallContext', 'precomputedOverallContext', 'context'];
const CONTEXT_ROOT = `(?:${CONTEXT_NAMES.join('|')})`;
const IDENT = '[A-Za-z_$][\\w$]*';
// One step of a member chain: `.x`, `?.x`, `.get(key)`, `[i]`, or a non-null `!`.
const STEP = `(?:\\s*(?:\\?\\.|\\.)\\s*(?:get\\([^()\\n]*\\)|${IDENT})|\\[[^\\]\\n]*\\]|!(?!=))`;
// Not preceded by an identifier character or a single dot (a spread `...x` is allowed).
const ROOT = `(?<![\\w$])(?<![^.]\\.)(${IDENT})`;
const MUTATING_METHODS = 'sort|reverse|splice|push|pop|shift|unshift|fill|copyWithin|set|add|delete|clear';

const WRITE_PATTERNS: RegExp[] = [
  new RegExp(`${ROOT}${STEP}*\\s*(?:\\?\\.|\\.)\\s*(?:${MUTATING_METHODS})\\s*\\(`, 'g'),
  new RegExp(`${ROOT}${STEP}+\\s*(?:\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?|[-+*/%&|^])?=(?![=>])`, 'g'),
  new RegExp(`${ROOT}${STEP}+\\s*(?:\\+\\+|--)`, 'g'),
  new RegExp(`(?:\\+\\+|--)\\s*${ROOT}${STEP}+`, 'g'),
  new RegExp(`\\bdelete\\s+${ROOT}${STEP}+`, 'g'),
  new RegExp(`\\bObject\\.assign\\(\\s*${ROOT}`, 'g'),
];

/**
 * Blanks out comments (keeping newlines, so line numbers hold) and leaves strings and template
 * literals alone. `ok` is false when the source ends inside a string or template, which would mean
 * the scan lost track of the code and its results cannot be trusted.
 */
function stripComments(source: string): { code: string; ok: boolean } {
  const out = source.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  // Each frame is code (with its open-brace depth) or the text part of a template literal.
  const stack: ({ mode: 'code'; depth: number } | { mode: 'template' })[] = [{ mode: 'code', depth: 0 }];
  let i = 0;
  while (i < source.length) {
    const frame = stack[stack.length - 1];
    const c = source[i];
    const next = source[i + 1];
    if (frame.mode === 'template') {
      if (c === '\\') i += 2;
      else if (c === '`') {
        stack.pop();
        i++;
      } else if (c === '$' && next === '{') {
        stack.push({ mode: 'code', depth: 0 });
        i += 2;
      } else i++;
      continue;
    }
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      if (source[j] !== c) return { code: out.join(''), ok: false };
      i = j + 1;
    } else if (c === '`') {
      stack.push({ mode: 'template' });
      i++;
    } else if (c === '{') {
      frame.depth++;
      i++;
    } else if (c === '}') {
      if (frame.depth === 0 && stack.length > 1) stack.pop();
      else frame.depth--;
      i++;
    } else i++;
  }
  return { code: out.join(''), ok: stack.length === 1 };
}

/** A right-hand side that is exactly a context field, such as `overallContext.overallScores`. */
const CONTEXT_FIELD_RHS = new RegExp(`^${CONTEXT_ROOT}(?:\\s*\\.\\s*${IDENT})+\\s*;?$`);

type AliasEvent = { index: number; name: string; alias: boolean };

/** Locals bound straight to a context field, in source order; a later redeclaration ends the alias. */
function aliasEvents(code: string): AliasEvent[] {
  const events: AliasEvent[] = [];
  const declaration = new RegExp(
    `\\b(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=;\\n]*)?=(?![=>])([^;\\n]*)`,
    'g',
  );
  for (const m of code.matchAll(declaration)) {
    events.push({ index: m.index!, name: m[1], alias: CONTEXT_FIELD_RHS.test(m[2].trim()) });
  }
  const assignment = new RegExp(`(?<![\\w$.])(${IDENT})\\s*=(?![=>])([^;\\n]*)`, 'g');
  for (const m of code.matchAll(assignment)) {
    if (CONTEXT_FIELD_RHS.test(m[2].trim())) events.push({ index: m.index!, name: m[1], alias: true });
  }
  const destructuring = new RegExp(
    `\\b(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${CONTEXT_ROOT}\\s*[;\\n]`,
    'g',
  );
  for (const m of code.matchAll(destructuring)) {
    for (const part of m[1].split(',')) {
      const binding = part.split('=')[0].split(':').pop()!.trim();
      if (binding) events.push({ index: m.index!, name: binding, alias: true });
    }
  }
  return events.sort((a, b) => a.index - b.index);
}

function isAliasAt(events: AliasEvent[], name: string, index: number): boolean {
  let active = false;
  for (const e of events) {
    if (e.index >= index) break;
    if (e.name === name) active = e.alias;
  }
  return active;
}

/** Every write through a context value, as `line N: <source line>`. */
function findContextWrites(source: string): string[] {
  const { code, ok } = stripComments(source);
  if (!ok) throw new Error('the comment stripper lost track of strings; the scan cannot be trusted');
  const events = aliasEvents(code);
  const lines = source.split('\n');
  const hits = new Map<number, string>();
  for (const pattern of WRITE_PATTERNS) {
    for (const m of code.matchAll(pattern)) {
      const root = m[1];
      const at = m.index! + m[0].indexOf(root);
      if (!CONTEXT_NAMES.includes(root) && !isAliasAt(events, root, at)) continue;
      const line = code.slice(0, at).split('\n').length;
      hits.set(line, `line ${line}: ${lines[line - 1].trim()}`);
    }
  }
  return [...hits.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text);
}

const RESULTS_SOURCES = import.meta.glob(['../../src/lib/results.ts', '../../src/lib/results/**/*.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('static scan for writes through a context value', () => {
  it('flags a planted sort on a context field', () => {
    expect(findContextWrites('overallContext.overallScores.sort();')).toEqual([
      'line 1: overallContext.overallScores.sort();',
    ]);
  });

  it.each([
    [
      'a mutating call on a local bound to a context field',
      'const scores = overallContext.overallScores;\nscores.sort((a, b) => a - b);',
      [2],
    ],
    [
      'a Map write through the precomputed context',
      "precomputedOverallContext.adjustments.set('k', v);",
      [1],
    ],
    ['an assignment to a context field', 'context.penalties = [];', [1]],
    ['an assignment through a Map lookup', 'overallContext.adjustments.get(key)!.newPosition = 1;', [1]],
    [
      'a later assignment of a context field to a local',
      'let scores: Row[];\nscores = precomputedOverallContext.overallScores;\nscores.push(row);',
      [3],
    ],
    ['a destructured context field', 'const { penalties } = overallContext;\npenalties.splice(0, 1);', [2]],
    ['a delete through a context field', 'delete overallContext.rawByKey;', [1]],
    ['an increment of a context field', 'overallContext.overallScores[0].finish_points++;', [1]],
  ])('flags %s', (_label, sample, lines) => {
    expect(findContextWrites(sample).map((hit) => Number(hit.split(':')[0].replace('line ', '')))).toEqual(
      lines,
    );
  });

  it.each([
    ['a spread copy', '[...overallContext.overallScores].sort(byPoints);'],
    ['a slice copy', 'overallContext.overallScores.slice().sort(byPoints);'],
    ['a Map copy', "new Map(overallContext.rawByKey).set('k', v);"],
    ['a Set copy', 'new Set(context.penalties).delete(p);'],
    ['a local holding a copy', 'const scores = [...overallContext.overallScores];\nscores.sort(byPoints);'],
    ['a comment', '// overallContext.overallScores.sort() would be a bug'],
    ['a comparison', 'if (overallContext.adjustments.get(key) === undefined) skip();'],
    [
      'a read through an aliased Map',
      'const rawByKey = overallContext.rawByKey;\nconst raw = rawByKey.get(k);',
    ],
    [
      'a same-named local in a later function',
      'function a() { const scores = overallContext.overallScores; }\nfunction b() { const scores = [2, 1];\nscores.sort(); }',
    ],
  ])('allows %s', (_label, sample) => {
    expect(findContextWrites(sample)).toEqual([]);
  });

  it('reads the results source', () => {
    const files = Object.keys(RESULTS_SOURCES);
    expect(files.length).toBeGreaterThan(0);
    // Guards against a vacuous pass: the scanned code really does use the context.
    expect(
      Object.values(RESULTS_SOURCES).some((source) => source.includes('overallContext.overallScores')),
    ).toBe(true);
  });

  it('finds no write through a context value in src/lib/results', () => {
    const writes = Object.entries(RESULTS_SOURCES).flatMap(([file, source]) =>
      findContextWrites(source).map((hit) => `${file} ${hit}`),
    );
    expect(writes).toEqual([]);
  });
});
