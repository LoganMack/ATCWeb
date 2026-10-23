// Pure helpers for scripts/compare-round-stats.mjs (unit precompute, BR4.1): compare the values
// today's TypeScript builders compute with the rows the database stores, group the differences,
// and render the report. No network and no file system, so tests can run them on plain objects.
//
// A record is { kind, season, round, subject, ...fields }: kind names the view ("overall",
// "class:Gamma", "extended", "team:overall", ...), round is a subsession id (or "season" for
// season totals), subject a driver id, team id or "driver|team" pair.

/** Causes a difference can have. "concealment", "value" and "missing-stored" block the switch. */
export const CAUSES = ['concealment', 'value', 'missing-stored', 'tie-order', 'stored-only'];
const BLOCKING = new Set(['concealment', 'value', 'missing-stored']);

/**
 * A stored row that shows an unposted round's final set or penalty points (BR3.1): every
 * round_penalty_points row, and every round_driver_stats row with final_visible, must belong to a
 * round whose round_incident_status is posted. `postedIds` is the set of posted subsession ids.
 */
export function concealmentViolations(seasonName, storedDrivers, storedPenalties, postedIds) {
  const violation = (round, subject, field, actual) => ({
    kind: 'concealment',
    season: seasonName,
    round,
    subject,
    field,
    expected: 'unposted: not shown',
    actual,
    cause: 'concealment',
  });
  const out = [];
  for (const t of storedDrivers) {
    if (t.final_visible && !postedIds.has(Number(t.subsession_id))) {
      out.push(violation(t.subsession_id, t.driver_id, 'final_visible', true));
    }
  }
  for (const p of storedPenalties) {
    if (!postedIds.has(Number(p.subsession_id))) {
      out.push(violation(p.subsession_id, p.driver_id, 'penalty_points', p.penalty_points));
    }
  }
  return out;
}

export function recordKey(record) {
  return `${record.kind}|${record.season}|${record.round}|${record.subject}`;
}

/** JSON with object keys sorted, so two car maps with the same counts compare equal. */
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

function isEmptyValue(value) {
  if (value === 0 || value === false || value === null || value === undefined) return true;
  return typeof value === 'object' && Object.keys(value).length === 0;
}

function differenceOf(record, field, expected, actual, cause) {
  return {
    kind: record.kind,
    season: record.season,
    round: record.round,
    subject: record.subject,
    field,
    expected,
    actual,
    cause,
  };
}

/**
 * Every difference between the expected (TypeScript) and actual (stored) records, field by field.
 * A stored record with no expected counterpart is reported as "stored-only" unless every compared
 * field is empty (0, false, {}): today's code simply has no entry for those.
 */
export function diffRecords(expected, actual, fields) {
  const actualByKey = new Map(actual.map((r) => [recordKey(r), r]));
  const expectedKeys = new Set();
  const differences = [];
  for (const exp of expected) {
    const key = recordKey(exp);
    expectedKeys.add(key);
    const act = actualByKey.get(key);
    if (!act) {
      differences.push(differenceOf(exp, '(row)', 'present', 'missing', 'missing-stored'));
      continue;
    }
    for (const field of fields) {
      if (stableJson(exp[field] ?? null) !== stableJson(act[field] ?? null)) {
        differences.push(differenceOf(exp, field, exp[field] ?? null, act[field] ?? null, 'value'));
      }
    }
  }
  for (const act of actual) {
    if (expectedKeys.has(recordKey(act))) continue;
    if (fields.every((field) => isEmptyValue(act[field]))) continue;
    differences.push(differenceOf(act, '(row)', 'missing', 'present', 'stored-only'));
  }
  return differences;
}

/**
 * "season|driver|team" for every driver in a race-team group whose top 2 is a points tie (the 2nd
 * and 3rd best score the same). Today's order on such a tie is unspecified, so a difference there
 * is listed apart for the owner to accept.
 */
export function findTopTwoTies(rows, seasonName, pointsOf) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.team_id) continue;
    const key = `${row.subsession_id}:${row.race_number}:${row.team_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const ties = new Set();
  for (const group of groups.values()) {
    if (group.length < 3) continue;
    const points = group.map(pointsOf).sort((a, b) => b - a);
    if (points[1] !== points[2]) continue;
    for (const row of group) {
      if (pointsOf(row) === points[1]) ties.add(`${seasonName}|${row.driver_id}|${row.team_id}`);
    }
  }
  return ties;
}

/** Re-labels as "tie-order" each difference in one of `fields` whose season and subject is a tie. */
export function markTieOrder(differences, ties, fields) {
  const tieFields = new Set(fields);
  return differences.map((d) =>
    d.cause === 'value' && tieFields.has(d.field) && ties.has(`${d.season}|${d.subject}`)
      ? { ...d, cause: 'tie-order' }
      : d,
  );
}

/** Counts per cause, and the differences grouped by cause, then kind and field. */
export function groupDifferences(differences) {
  const counts = Object.fromEntries(CAUSES.map((c) => [c, 0]));
  const groups = new Map();
  for (const d of differences) {
    counts[d.cause] += 1;
    const label = `${d.kind} / ${d.field}`;
    if (!groups.has(d.cause)) groups.set(d.cause, new Map());
    const byLabel = groups.get(d.cause);
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(d);
  }
  const blocking = differences.filter((d) => BLOCKING.has(d.cause)).length;
  return { counts, groups, blocking };
}

const CAUSE_TITLES = {
  concealment: 'Unposted rounds showing final values or penalty points (block U3)',
  value: 'Value differences (block U3)',
  'missing-stored': 'Rows today computes that are not stored (block U3)',
  'tie-order': 'Team top-2 tie order (for the owner to accept)',
  'stored-only': 'Stored rows today has no entry for (informational)',
};

function cell(value) {
  return String(stableJson(value)).replace(/\|/g, '\\|');
}

/** The Markdown report. `examples` caps the rows listed per group; counts are always complete. */
export function renderReport({ generatedAt, source, seasons, recordCounts, differences, examples = 20 }) {
  const { counts, groups, blocking } = groupDifferences(differences);
  const lines = [
    '# Round stats parity',
    '',
    `- Generated: ${generatedAt}`,
    `- Source: ${source} (anon key, read-only)`,
    `- Seasons: ${seasons.join(', ') || 'none'}`,
    `- Records compared: ${Object.entries(recordCounts)
      .map(([kind, n]) => `${kind} ${n}`)
      .join(', ')}`,
    `- Result: ${blocking === 0 ? 'PASS, 0 blocking differences' : `FAIL, ${blocking} blocking differences`}`,
    '',
    '| Cause | Count |',
    '|---|---|',
    ...CAUSES.map((c) => `| ${c} | ${counts[c]} |`),
  ];
  for (const cause of CAUSES) {
    const byLabel = groups.get(cause);
    if (!byLabel) continue;
    lines.push('', `## ${CAUSE_TITLES[cause]}`);
    for (const [label, list] of [...byLabel.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(
        '',
        `### ${label} (${list.length})`,
        '',
        '| Season | Round | Subject | Today | Stored |',
        '|---|---|---|---|---|',
      );
      for (const d of list.slice(0, examples)) {
        lines.push(`| ${d.season} | ${d.round} | ${d.subject} | ${cell(d.expected)} | ${cell(d.actual)} |`);
      }
      if (list.length > examples) lines.push(``, `${list.length - examples} more not listed.`);
    }
  }
  return `${lines.join('\n')}\n`;
}
