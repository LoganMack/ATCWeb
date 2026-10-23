/**
 * Per-request memo (BR4.1): one render reads the same reference data or lookup once. The middleware creates
 * one per request on `locals.memo` and resolveSupabaseEnv carries it, so two requests never share entries.
 * A rejected entry is dropped, so a retry in the same request runs again. In development and tests the
 * results are deep-frozen, so a caller that mutates a shared result fails loudly instead of corrupting it.
 */
export class RequestMemo {
  private readonly entries = new Map<string, Promise<unknown>>();

  constructor(private readonly freeze: boolean = freezeByDefault()) {}

  /** The memoised result of `load`, keyed by `name` and the JSON of `args` (never the env). */
  run<T>(name: string, args: readonly unknown[], load: () => Promise<T>): Promise<T> {
    const key = `${name}:${JSON.stringify(args)}`;
    const existing = this.entries.get(key);
    if (existing) return existing as Promise<T>;
    const pending = load().then((value) => (this.freeze ? deepFreeze(value) : value));
    this.entries.set(key, pending);
    pending.catch(() => {
      if (this.entries.get(key) === pending) this.entries.delete(key);
    });
    return pending;
  }

  /** How many entries are held (pending or resolved). */
  get size(): number {
    return this.entries.size;
  }
}

/** Anything that may carry a request's memo, such as a SupabaseEnv. */
export interface MemoCarrier {
  memo?: RequestMemo;
}

/** `load()` through the carrier's memo, or straight through when there is none (scripts, tests, prerender). */
export function memoized<T>(
  carrier: MemoCarrier,
  name: string,
  args: readonly unknown[],
  load: () => Promise<T>,
): Promise<T> {
  return carrier.memo ? carrier.memo.run(name, args, load) : load();
}

function freezeByDefault(): boolean {
  try {
    return import.meta.env?.DEV === true;
  } catch {
    return false;
  }
}

const MUTATORS = ['set', 'add', 'delete', 'clear'] as const;

/**
 * Freezes every object and array reachable from `value`. Map and Set mutators are replaced with functions
 * that throw, because Object.freeze does not stop Map.set or Set.add.
 */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      deepFreeze(key, seen);
      deepFreeze(entry, seen);
    }
  } else if (value instanceof Set) {
    for (const entry of value) deepFreeze(entry, seen);
  }
  if (value instanceof Map || value instanceof Set) {
    for (const name of MUTATORS) {
      Object.defineProperty(value, name, {
        value: () => {
          throw new TypeError(`${name}() called on a memoised result shared by this request`);
        },
      });
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}
