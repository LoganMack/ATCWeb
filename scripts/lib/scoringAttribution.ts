// Cause attribution for the scoring comparison (unit scoring-ownership, W5; BR6.2).
//
// Pure: no I/O. scripts/compare-scoring.ts gathers, per (round, race, driver, audience), what the
// site shows today, what the new view shows, and the score_round_preview results, and this module
// turns them into difference lines with their causes, plus the report and the decisions file.
//
// A difference between Today and New in one field is attributed (BR6.2):
//   * to switch c when the preview with only c on differs from Legacy-mode (every switch off) in
//     that field;
//   * when no single switch does, to a pair "c1+c2" of the switches that touched the row, when the
//     preview with both on differs from Legacy-mode in that field;
//   * to stale-stored-score when the stored race_scores value differs from Legacy-mode's raw set;
//   * to admin-view when the same field shows no difference for the non-admin audience.
// A line can have several causes; a line with none is unexplained.

export const SWITCHES = [
  'deduction-sign',
  'bonus-after-reorder',
  'cross-class-ripple',
  'per-class-pricing',
  'overall-formula',
  'short-points-table',
  'non-race-penalty',
  'dsq-flat-penalty',
  'class-position-ranking',
  'reorder-tie-break',
] as const;
export type SwitchName = (typeof SWITCHES)[number];

/**
 * The fields compared per race and driver. `row` is 1 when the row exists in that source and 0
 * when it does not, so a row present on one side only is one line instead of one per field.
 */
export const FIELDS = [
  'row',
  'position',
  'class_position',
  'finish_points',
  'class_view_finish_points',
  'class_points',
  'finesse_bonus',
  'pole_bonus',
  'aggression_bonus',
  'lap_led_bonus',
  'fewest_incidents_bonus',
  'fastest_lap_bonus',
  'sprint_sweep_bonus',
  'deduction',
  'overall_total',
  'class_total',
] as const;
export type Field = (typeof FIELDS)[number];

export type FieldValues = Partial<Record<Field, number | null>>;

export const AUDIENCES = ['non-admin', 'admin'] as const;
export type Audience = (typeof AUDIENCES)[number];

export const STALE_STORED_SCORE = 'stale-stored-score';
export const ADMIN_VIEW = 'admin-view';
export const UNEXPLAINED = 'unexplained';

export const DECISIONS = ['accept-new', 'keep-today', 'undecided'] as const;
export type Decision = (typeof DECISIONS)[number];

export interface AudienceInput {
  today: FieldValues;
  new: FieldValues;
  /** score_round_preview with every switch false, in the set this audience sees. */
  legacy: FieldValues;
  /** One preview per switch, that switch alone true. A missing switch never explains a line. */
  singles: Partial<Record<SwitchName, FieldValues>>;
  /** Previews with two switches true, keyed by pairKey(). Only the pairs pairsNeeded() asked for. */
  pairs?: Record<string, FieldValues>;
}

export interface RowInput {
  subsessionId: number;
  raceNumber: number;
  driverId: string;
  driverName?: string;
  audiences: Partial<Record<Audience, AudienceInput>>;
  /** The legacy race_scores values (the table today's pages start from), raw by construction. */
  storedRaw?: FieldValues;
  /** Legacy-mode's raw set, in the same field shape as storedRaw. */
  legacyRaw?: FieldValues;
}

export interface DiffLine {
  subsessionId: number;
  raceNumber: number;
  driverId: string;
  driverName?: string;
  audience: Audience;
  field: Field;
  today: number | null;
  new: number | null;
  /** Every cause that explains the line, in canonical order; empty means unexplained. */
  causes: string[];
  /** Whether Legacy-mode reproduces today's value; false flags a switch whose off-behaviour is not today's site. */
  legacyMatchesToday: boolean;
}

function valueOf(values: FieldValues | undefined, field: Field): number | null {
  const v = values?.[field];
  return v === undefined ? null : v;
}

function same(a: FieldValues | undefined, b: FieldValues | undefined, field: Field): boolean {
  return valueOf(a, field) === valueOf(b, field);
}

/** The canonical name of a pair: the two switches in SWITCHES order, joined with "+". */
export function pairKey(a: SwitchName, b: SwitchName): string {
  if (a === b) throw new Error(`A pair needs two different switches (got ${a} twice)`);
  return SWITCHES.indexOf(a) < SWITCHES.indexOf(b) ? `${a}+${b}` : `${b}+${a}`;
}

/** The two switches of a pair key, in canonical order. */
export function pairSwitches(key: string): [SwitchName, SwitchName] {
  const parts = key.split('+');
  if (parts.length !== 2 || !parts.every((p) => (SWITCHES as readonly string[]).includes(p))) {
    throw new Error(`Not a pair of scoring switches: ${key}`);
  }
  return [parts[0] as SwitchName, parts[1] as SwitchName];
}

/** The JSON switches for score_round_preview with exactly `on` switched on and every other switch off. */
export function switchesWithOnly(on: readonly SwitchName[]): Record<SwitchName, boolean> {
  const out = {} as Record<SwitchName, boolean>;
  for (const s of SWITCHES) out[s] = on.includes(s);
  return out;
}

function differingFields(a: AudienceInput): Field[] {
  return FIELDS.filter((f) => !same(a.today, a.new, f));
}

function singleCauses(a: AudienceInput, field: Field): SwitchName[] {
  return SWITCHES.filter((s) => a.singles[s] !== undefined && !same(a.singles[s], a.legacy, field));
}

/** Switches whose single preview differs from Legacy-mode in any field of this row and audience. */
function touchingSwitches(a: AudienceInput): SwitchName[] {
  return SWITCHES.filter((s) => {
    const single = a.singles[s];
    return single !== undefined && FIELDS.some((f) => !same(single, a.legacy, f));
  });
}

function candidatePairs(a: AudienceInput): string[] {
  const touched = touchingSwitches(a);
  const out: string[] = [];
  for (let i = 0; i < touched.length; i++) {
    for (let j = i + 1; j < touched.length; j++) out.push(pairKey(touched[i], touched[j]));
  }
  return out;
}

/** The pair previews this row needs: pairs of touching switches, for lines no single switch explains. */
export function pairsNeeded(row: RowInput): string[] {
  const needed = new Set<string>();
  for (const audience of AUDIENCES) {
    const a = row.audiences[audience];
    if (!a) continue;
    const unexplainedBySingles = differingFields(a).some((f) => singleCauses(a, f).length === 0);
    if (unexplainedBySingles) for (const k of candidatePairs(a)) needed.add(k);
  }
  return [...needed];
}

/** Every difference line for one race and driver, both audiences, with its causes (BR6.2). */
export function attributeRow(row: RowInput): DiffLine[] {
  const lines: DiffLine[] = [];
  const nonAdmin = row.audiences['non-admin'];
  for (const audience of AUDIENCES) {
    const a = row.audiences[audience];
    if (!a) continue;
    for (const field of differingFields(a)) {
      const causes: string[] = [...singleCauses(a, field)];
      if (causes.length === 0) {
        for (const key of candidatePairs(a)) {
          const pair = a.pairs?.[key];
          if (pair !== undefined && !same(pair, a.legacy, field)) causes.push(key);
        }
      }
      if (
        row.storedRaw &&
        row.legacyRaw &&
        field in row.storedRaw &&
        field in row.legacyRaw &&
        !same(row.storedRaw, row.legacyRaw, field)
      ) {
        causes.push(STALE_STORED_SCORE);
      }
      if (audience === 'admin' && nonAdmin && same(nonAdmin.today, nonAdmin.new, field)) {
        causes.push(ADMIN_VIEW);
      }
      lines.push({
        subsessionId: row.subsessionId,
        raceNumber: row.raceNumber,
        driverId: row.driverId,
        driverName: row.driverName,
        audience,
        field,
        today: valueOf(a.today, field),
        new: valueOf(a.new, field),
        causes,
        legacyMatchesToday: same(a.legacy, a.today, field),
      });
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

/** Order causes are listed in: single switches, pairs, stale-stored-score, admin-view, unexplained. */
function causeRank(cause: string): number {
  const single = (SWITCHES as readonly string[]).indexOf(cause);
  if (single >= 0) return single;
  if (cause.includes('+')) return 100;
  if (cause === STALE_STORED_SCORE) return 200;
  if (cause === ADMIN_VIEW) return 201;
  return 300;
}

function compareCauses(a: string, b: string): number {
  return causeRank(a) - causeRank(b) || a.localeCompare(b);
}

function compareLines(a: DiffLine, b: DiffLine): number {
  return (
    a.subsessionId - b.subsessionId ||
    a.raceNumber - b.raceNumber ||
    a.driverId.localeCompare(b.driverId) ||
    AUDIENCES.indexOf(a.audience) - AUDIENCES.indexOf(b.audience) ||
    FIELDS.indexOf(a.field) - FIELDS.indexOf(b.field)
  );
}

export interface CauseGroup {
  cause: string;
  lines: DiffLine[];
  rounds: number[];
}

/** Lines grouped by cause; a line with several causes is in each group, an unexplained one in "unexplained". */
export function groupByCause(lines: DiffLine[]): CauseGroup[] {
  const groups = new Map<string, DiffLine[]>();
  for (const line of lines) {
    const keys = line.causes.length > 0 ? line.causes : [UNEXPLAINED];
    for (const key of keys) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(line);
    }
  }
  return [...groups.keys()].sort(compareCauses).map((cause) => {
    const groupLines = [...groups.get(cause)!].sort(compareLines);
    return { cause, lines: groupLines, rounds: [...new Set(groupLines.map((l) => l.subsessionId))].sort((x, y) => x - y) };
  });
}

export interface ReportMeta {
  generatedAt: string;
  roundsCompared: number;
  roundsWithDifferences: number;
  /** Rounds not compared, with why (for example an open scoring_issues row). */
  roundsSkipped?: { subsessionId: number; reason: string }[];
  /** Free-text notes printed under the heading, for example how each field's Today value is read. */
  notes?: string[];
}

function cell(v: number | null): string {
  return v === null ? '—' : String(v);
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function lineRow(l: DiffLine): string {
  const driver = escapeCell(l.driverName ? `${l.driverName} (${l.driverId})` : l.driverId);
  const causes = l.causes.length > 0 ? l.causes.join(', ') : UNEXPLAINED;
  return `| ${l.subsessionId} | ${l.raceNumber} | ${driver} | ${l.audience} | ${l.field} | ${cell(l.today)} | ${cell(l.new)} | ${causes} |`;
}

/** report.md: counts per cause first, then every line under each of its causes. */
export function renderReport(lines: DiffLine[], meta: ReportMeta): string {
  const groups = groupByCause(lines);
  const unexplained = lines.filter((l) => l.causes.length === 0).length;
  const out: string[] = [];
  out.push('# Scoring comparison: today versus database-owned scoring', '');
  out.push(`Generated: ${meta.generatedAt}`, '');
  out.push(
    `- Rounds compared: ${meta.roundsCompared}`,
    `- Rounds with a difference: ${meta.roundsWithDifferences}`,
    `- Difference lines: ${lines.length}`,
    `- Unexplained lines: ${unexplained}`,
  );
  if (meta.roundsSkipped && meta.roundsSkipped.length > 0) {
    out.push(`- Rounds skipped: ${meta.roundsSkipped.length}`);
  }
  out.push('');
  for (const note of meta.notes ?? []) out.push(`> ${note}`, '');

  out.push('## Counts by cause', '');
  out.push('A line with several causes is counted under each of them.', '');
  out.push('| Cause | Lines | Rounds |', '|---|---:|---:|');
  for (const g of groups) out.push(`| ${g.cause} | ${g.lines.length} | ${g.rounds.length} |`);
  out.push('');

  // admin-view lines are left out: there Today is the concealed raw set and Legacy-mode the final set.
  const mismatch = lines.filter((l) => !l.legacyMatchesToday && !l.causes.includes(ADMIN_VIEW));
  if (mismatch.length > 0) {
    out.push('## Lines where Legacy-mode does not reproduce today', '');
    out.push(
      'On these lines the preview with every switch off differs from what the site shows today, so a switch may not',
      "fully reproduce today's behaviour. Their attribution still follows BR6.2. admin-view lines are not counted.",
      '',
    );
    out.push('| Field | Lines |', '|---|---:|');
    const byField = new Map<Field, number>();
    for (const l of mismatch) byField.set(l.field, (byField.get(l.field) ?? 0) + 1);
    for (const f of FIELDS) if (byField.has(f)) out.push(`| ${f} | ${byField.get(f)} |`);
    out.push('');
  }

  for (const g of groups) {
    out.push(`## ${g.cause} (${g.lines.length} lines, ${g.rounds.length} rounds)`, '');
    out.push('| Round | Race | Driver | Audience | Field | Today | New | Causes |', '|---:|---:|---|---|---|---:|---:|---|');
    for (const l of g.lines) out.push(lineRow(l));
    out.push('');
  }

  if (meta.roundsSkipped && meta.roundsSkipped.length > 0) {
    out.push('## Rounds skipped', '', '| Round | Reason |', '|---:|---|');
    for (const s of meta.roundsSkipped) out.push(`| ${s.subsessionId} | ${escapeCell(s.reason)} |`);
    out.push('');
  }
  return out.join('\n');
}

export interface DecisionsFile {
  generatedAt: string;
  allowedDecisions: readonly Decision[];
  causes: { cause: string; decision: Decision; lines: number; rounds: number[] }[];
}

/** decisions.json: one `undecided` entry per cause present (and one for unexplained lines, if any). */
export function renderDecisions(lines: DiffLine[], generatedAt: string): DecisionsFile {
  return {
    generatedAt,
    allowedDecisions: DECISIONS,
    causes: groupByCause(lines).map((g) => ({
      cause: g.cause,
      decision: 'undecided' as Decision,
      lines: g.lines.length,
      rounds: g.rounds,
    })),
  };
}
