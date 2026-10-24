#!/usr/bin/env node
// Masked-view embed check (U4 driver privacy, NFR8.6), run by the `migrations-rebuild` job after the
// fixtures, against the throwaway local Supabase that job starts:
//
//   node supabase/tools/check-view-embeds.mjs
//
// Every select string the site's readers send through the masked *_shown views lives in
// src/lib/privacyReads.json (the readers import the same file). For each one this calls the local PostgREST,
// as anon and with an admin token where the entry lists them, and fails on any status other than 200, on no
// rows, or on an embed that comes back empty for the seeded rows (an embed emptied by Row Level Security
// returns 200, so the status alone would not catch it).
//
// The rows it needs (an admin, a hidden driver with a team, a posted penalty with an offense and an involved
// driver, a news post and a meetup tagging the driver, a kudos) are inserted and committed with psql first,
// and deleted again at the end, also on failure. The admin token is signed with the local JWT secret that
// `supabase status` reports. Connection details can be overridden with DB_URL, SUPABASE_API_URL,
// SUPABASE_ANON_KEY and SUPABASE_JWT_SECRET.
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const READS_FILE = join(ROOT, 'src', 'lib', 'privacyReads.json');
const DEFAULT_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export const SEED = {
  admin: 'eeeeeeee-0000-0000-0000-000000000701',
  owner: 'eeeeeeee-0000-0000-0000-000000000702',
  driver: '99999999-0000-0000-0000-000000000701',
  other: '99999999-0000-0000-0000-000000000702',
  team: 'cccccccc-0000-0000-0000-000000000701',
  round: 9907001,
  penalty: 'cccccccc-0000-0000-0000-000000000711',
  offense: 'cccccccc-0000-0000-0000-000000000712',
  post: 'cccccccc-0000-0000-0000-000000000721',
  meetup: 'cccccccc-0000-0000-0000-000000000731',
  kudos: 'cccccccc-0000-0000-0000-000000000741',
};

/** The filter that narrows each read to the seeded rows. Every entry in privacyReads.json needs one. */
export const FILTERS = {
  driverList: `id=eq.${SEED.driver}`,
  driverProfile: `id=eq.${SEED.driver}`,
  penalties: `id=eq.${SEED.penalty}`,
  penaltiesInvolving: `id=eq.${SEED.penalty}&involved_match.driver_id=eq.${SEED.other}`,
  newsPostDrivers: `post_id=eq.${SEED.post}`,
  meetupDrivers: `meetup_id=eq.${SEED.meetup}`,
  kudos: `id=eq.${SEED.kudos}`,
  profile: `id=eq.${SEED.owner}`,
};

const SEED_SQL = `
update public.scoring_settings set triggers_enabled = false;
insert into public.driver_statuses (id, name) values (831, 'Embed Check Status');
insert into public.driver_classes (id, name, sort_order) values (831, 'Embed Check Class', 99);
insert into public.teams (id, name) values ('${SEED.team}', 'Embed Check Team');
insert into public.drivers (id, name, car_number, status_id, class_id, team_id, iracing_cust_id, is_ai) values
  ('${SEED.driver}', 'Embed Hidden Driver', 871, 831, 831, '${SEED.team}', 990000701, false),
  ('${SEED.other}', 'Embed Other Driver', 872, 831, 831, '${SEED.team}', 990000702, false);
insert into auth.users (id, email, raw_user_meta_data) values
  ('${SEED.admin}', 'embed-admin@example.test', '{"display_name":"Embed Admin"}'),
  ('${SEED.owner}', 'embed-owner@example.test', '{"display_name":"Embed Owner"}');
delete from public.profiles where id in ('${SEED.admin}', '${SEED.owner}');
insert into public.profiles (id, role, display_name) values ('${SEED.admin}', 'admin', 'Embed Admin');
insert into public.profiles (id, role, display_name, driver_id) values ('${SEED.owner}', 'driver', 'Embed Owner', '${SEED.driver}');
insert into public.account_settings (profile_id, hide_name) values ('${SEED.owner}', true);
insert into public.curated_rounds (subsession_id, start_time, track_name) values (${SEED.round}, '2026-06-01 18:00+00', 'Embed Park');
insert into public.round_incident_status (subsession_id, posted) values (${SEED.round}, true);
insert into public.penalty_offenses (id, name) values ('${SEED.offense}', 'Embed Check Offense');
insert into public.penalties (id, subsession_id, race_number, driver_id, description) values
  ('${SEED.penalty}', ${SEED.round}, 1, '${SEED.driver}', 'Embed Hidden Driver hit Embed Other Driver');
insert into public.penalty_offense_links (penalty_id, offense_id) values ('${SEED.penalty}', '${SEED.offense}');
insert into public.penalty_involved_drivers (penalty_id, driver_id) values ('${SEED.penalty}', '${SEED.other}');
insert into public.news_posts (id, slug, title, body, author_name) values
  ('${SEED.post}', 'embed-check-post', 'Embed check', 'Body', 'Embed Admin');
insert into public.news_post_drivers (post_id, driver_id) values ('${SEED.post}', '${SEED.driver}');
insert into public.media_meetups (id, title, latitude, longitude) values ('${SEED.meetup}', 'Embed Meetup', 0, 0);
insert into public.media_meetup_drivers (meetup_id, driver_id) values ('${SEED.meetup}', '${SEED.driver}');
insert into public.kudos (id, subsession_id, session, lap, turn, author_id, author_name) values
  ('${SEED.kudos}', ${SEED.round}, 'race', 1, 'Turn 1', '${SEED.owner}', 'Embed Hidden Driver');
insert into public.kudos_drivers (kudos_id, driver_id) values ('${SEED.kudos}', '${SEED.driver}');
update public.scoring_settings set triggers_enabled = true;
`;

const CLEANUP_SQL = `
update public.scoring_settings set triggers_enabled = false;
delete from public.kudos_drivers where kudos_id = '${SEED.kudos}';
delete from public.kudos where id = '${SEED.kudos}';
delete from public.media_meetup_drivers where meetup_id = '${SEED.meetup}';
delete from public.media_meetups where id = '${SEED.meetup}';
delete from public.news_post_drivers where post_id = '${SEED.post}';
delete from public.news_posts where id = '${SEED.post}';
delete from public.penalty_involved_drivers where penalty_id = '${SEED.penalty}';
delete from public.penalty_offense_links where penalty_id = '${SEED.penalty}';
delete from public.penalties where id = '${SEED.penalty}';
delete from public.penalty_offenses where id = '${SEED.offense}';
delete from public.round_incident_status where subsession_id = ${SEED.round};
delete from public.curated_rounds where subsession_id = ${SEED.round};
delete from public.account_settings where profile_id in ('${SEED.admin}', '${SEED.owner}');
delete from public.profiles where id in ('${SEED.admin}', '${SEED.owner}');
delete from auth.users where id in ('${SEED.admin}', '${SEED.owner}');
delete from public.drivers where id in ('${SEED.driver}', '${SEED.other}');
delete from public.teams where id = '${SEED.team}';
delete from public.driver_classes where id = 831;
delete from public.driver_statuses where id = 831;
update public.scoring_settings set triggers_enabled = true;
`;

/** KEY="value" lines from `supabase status -o env`. */
export function parseStatusEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(?:"(.*)"|(.*))$/.exec(line.trim());
    if (match) out[match[1]] = match[2] ?? match[3];
  }
  return out;
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

/** An HS256 JWT, as Supabase's own auth server signs them. */
export function signJwt(payload, secret) {
  const head = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

/** What is wrong with one response, or null when it passes: 200, at least one row, every embed non-empty. */
export function embedProblem(status, rows, embeds) {
  if (status !== 200) return `status ${status}`;
  if (!Array.isArray(rows) || rows.length === 0) return 'no rows';
  for (const key of embeds) {
    const value = rows[0][key];
    if (value === undefined) return `embed ${key} missing from the response`;
    if (value === null || (Array.isArray(value) && value.length === 0)) return `embed ${key} is empty`;
  }
  return null;
}

/** Every read and caller to call, with the URL path; throws when an entry has no seed filter. */
export function plannedCalls(reads, filters) {
  const calls = [];
  for (const [name, read] of Object.entries(reads)) {
    const filter = filters[name];
    if (!filter) throw new Error(`privacyReads.json entry "${name}" has no filter in check-view-embeds.mjs`);
    for (const caller of read.callers) {
      calls.push({
        name,
        caller,
        embeds: read.embeds,
        url: `${read.path}?select=${encodeURIComponent(read.select)}&${filter}`,
      });
    }
  }
  return calls;
}

function psql(dbUrl, sql) {
  execFileSync('psql', [dbUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-c', sql], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

function localStatus() {
  try {
    return parseStatusEnv(execFileSync('npx', ['supabase', 'status', '-o', 'env'], { encoding: 'utf8', shell: true }));
  } catch (error) {
    throw new Error(`could not read \`supabase status\`: ${error.message}`);
  }
}

async function main() {
  const status =
    process.env.SUPABASE_API_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_JWT_SECRET
      ? {}
      : localStatus();
  const apiUrl = process.env.SUPABASE_API_URL ?? status.API_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? status.ANON_KEY;
  const jwtSecret = process.env.SUPABASE_JWT_SECRET ?? status.JWT_SECRET;
  const dbUrl = process.env.DB_URL ?? DEFAULT_DB_URL;
  if (!apiUrl || !anonKey || !jwtSecret) throw new Error('API_URL, ANON_KEY or JWT_SECRET not found');

  const reads = JSON.parse(readFileSync(READS_FILE, 'utf8'));
  const calls = plannedCalls(reads, FILTERS);
  const now = Math.floor(Date.now() / 1000);
  const adminToken = signJwt(
    { sub: SEED.admin, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 600 },
    jwtSecret,
  );

  psql(dbUrl, CLEANUP_SQL);
  psql(dbUrl, SEED_SQL);
  const failures = [];
  try {
    for (const call of calls) {
      const token = call.caller === 'admin' ? adminToken : anonKey;
      const res = await fetch(`${apiUrl}/rest/v1/${call.url}`, {
        headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
      });
      const text = await res.text();
      let rows = null;
      try {
        rows = JSON.parse(text);
      } catch {
        rows = null;
      }
      const problem = embedProblem(res.status, rows, call.embeds);
      if (problem) {
        failures.push(`${call.name} as ${call.caller}: ${problem}${res.status === 200 ? '' : ` (${text.slice(0, 300)})`}`);
      } else {
        console.log(`ok ${call.name} as ${call.caller}`);
      }
    }
  } finally {
    psql(dbUrl, CLEANUP_SQL);
  }

  const inActions = process.env.GITHUB_ACTIONS === 'true';
  for (const failure of failures) console.error(inActions ? `::error file=src/lib/privacyReads.json::${failure}` : failure);
  if (failures.length > 0) {
    console.error(`${failures.length} masked-view read(s) failed.`);
    process.exit(1);
  }
  console.log(`Masked view embeds: all ${calls.length} calls passed.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`check-view-embeds: ${error.message}`);
    process.exit(2);
  });
}
