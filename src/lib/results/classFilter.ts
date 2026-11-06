/**
 * The one shared definition of the driver-stats class filter (FR3.13, BR3.1-BR3.4): Overall is the classless
 * finishing order, Combined is the old sum of class results, and a class keeps only that class's seasons.
 * Every page that offers the filter resolves, labels and links it through here, so they cannot drift apart.
 */

/** The position-based counts for one round or season under one counting rule. */
export interface StatCounts {
  wins: number;
  podiums: number;
  top5s: number;
  top10s: number;
  poles: number;
}

/** Anything that carries both counting rules side by side (a career season row or one of its rounds). */
export interface CountsSource {
  classCounts: StatCounts;
  overallCounts: StatCounts;
}

export type ClassFilter =
  | { kind: 'overall'; label: 'Overall'; addressValue: null; classId: null }
  | { kind: 'combined'; label: 'Combined'; addressValue: 'Combined'; classId: null }
  | { kind: 'class'; label: string; addressValue: string; classId: number };

/** The driver classes the filter offers, in driver_classes order. */
export const FILTER_CLASS_NAMES = ['Alpha', 'Gamma', 'Delta'] as const;

/**
 * Every address value the filter understands. The edge cache keeps only these in its key (BR5.2), so the
 * resolver must match them exactly: a value it accepted but the cache dropped would be stored under the bare
 * address and served to Overall visitors.
 */
export const CLASS_FILTER_VALUES: readonly string[] = ['Overall', 'Combined', ...FILTER_CLASS_NAMES];

export const OVERALL_FILTER: ClassFilter = {
  kind: 'overall',
  label: 'Overall',
  addressValue: null,
  classId: null,
};
export const COMBINED_FILTER: ClassFilter = {
  kind: 'combined',
  label: 'Combined',
  addressValue: 'Combined',
  classId: null,
};

/** The classes the filter offers, from the driver_classes rows, keeping only the known names. */
function filterClasses(classes: { id: number; name: string }[]): ClassFilter[] {
  const out: ClassFilter[] = [];
  for (const c of classes) {
    if (!(FILTER_CLASS_NAMES as readonly string[]).includes(c.name)) continue;
    out.push({ kind: 'class', label: c.name, addressValue: c.name, classId: c.id });
  }
  return out;
}

/**
 * The filter an address value asks for (BR3.1). Absent, empty, `Overall` or anything unknown is Overall, never
 * an error. Matching is exact (`alpha` is Overall) for the reason given on CLASS_FILTER_VALUES.
 */
export function resolveClassFilter(
  value: string | null | undefined,
  classes: { id: number; name: string }[],
): ClassFilter {
  if (value === 'Combined') return COMBINED_FILTER;
  return filterClasses(classes).find((f) => f.addressValue === value) ?? OVERALL_FILTER;
}

export interface ClassFilterOption {
  label: string;
  /** The destination address; Overall's carries no `class` value. */
  href: string;
  selected: boolean;
}

/**
 * The five options in order (Overall, Combined, then the classes), each with its address. `params` are other
 * address values to keep (for example a season), written before `class`.
 */
export function classFilterOptions(
  basePath: string,
  current: ClassFilter,
  classes: { id: number; name: string }[],
  params: Record<string, string> = {},
): ClassFilterOption[] {
  const all = [OVERALL_FILTER, COMBINED_FILTER, ...filterClasses(classes)];
  return all.map((f) => {
    const search = new URLSearchParams(params);
    if (f.addressValue !== null) search.set('class', f.addressValue);
    const query = search.toString();
    return {
      label: f.label,
      href: query ? `${basePath}?${query}` : basePath,
      selected: f.kind === current.kind && f.classId === current.classId,
    };
  });
}

/** The counts a row shows under the filter: the classless counts under Overall, class counts otherwise. */
export function countsFor(source: CountsSource, filter: ClassFilter): StatCounts {
  return filter.kind === 'overall' ? source.overallCounts : source.classCounts;
}

/** Whether a season raced in `classId` counts under the filter (every season unless a class is chosen). */
export function filterKeepsClass(filter: ClassFilter, classId: number): boolean {
  return filter.kind !== 'class' || filter.classId === classId;
}

export function emptyCounts(): StatCounts {
  return { wins: 0, podiums: 0, top5s: 0, top10s: 0, poles: 0 };
}

/** Adds `b` into `a` (mutates and returns `a`). */
export function addCounts(a: StatCounts, b: StatCounts): StatCounts {
  a.wins += b.wins;
  a.podiums += b.podiums;
  a.top5s += b.top5s;
  a.top10s += b.top10s;
  a.poles += b.poles;
  return a;
}
