// Tests for the pure parts of check-view-embeds.mjs. No database or network is used.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CLEANUP_SQL,
  EMBED_EXPECT,
  EMBED_FILTERS,
  FILTERS,
  SEED_SQL,
  embedProblem,
  parseStatusEnv,
  plannedCalls,
  signJwt,
} from './check-view-embeds.mjs';

const reads = JSON.parse(readFileSync(new URL('../../src/lib/privacyReads.json', import.meta.url), 'utf8'));
const embedReads = JSON.parse(readFileSync(new URL('../../src/lib/embedReads.json', import.meta.url), 'utf8'));

describe('check-view-embeds', () => {
  it('has a seed filter for every read in privacyReads.json, and no stale ones', () => {
    assert.deepEqual(Object.keys(FILTERS).sort(), Object.keys(reads).sort());
  });

  it('calls each read once per listed caller, through the view path and the encoded select', () => {
    const calls = plannedCalls(reads, FILTERS);
    const expected = Object.values(reads).reduce((n, r) => n + r.callers.length, 0);
    assert.equal(calls.length, expected);
    const driverList = calls.find((c) => c.name === 'driverList' && c.caller === 'anon');
    assert.ok(driverList.url.startsWith('drivers_shown?select='));
    assert.ok(driverList.url.includes(encodeURIComponent('teams!drivers_team_id_fkey(')));
    assert.ok(driverList.url.endsWith(`&${FILTERS.driverList}`));
  });

  it('refuses a read with no seed filter', () => {
    assert.throws(() => plannedCalls({ extra: { path: 'x', select: 'id', embeds: [], callers: ['anon'] } }, {}), /extra/);
  });

  it('passes a 200 with rows and filled embeds, and names what is wrong otherwise', () => {
    assert.equal(embedProblem(200, [{ id: 1, teams: { name: 'T' }, links: [{ a: 1 }] }], ['teams', 'links']), null);
    assert.equal(embedProblem(400, { message: 'bad' }, []), 'status 400');
    assert.equal(embedProblem(200, [], []), 'no rows');
    assert.equal(embedProblem(200, [{ id: 1, teams: null }], ['teams']), 'embed teams is empty');
    assert.equal(embedProblem(200, [{ id: 1, links: [] }], ['links']), 'embed links is empty');
    assert.equal(embedProblem(200, [{ id: 1 }], ['teams']), 'embed teams missing from the response');
  });

  it('reads the supabase status env output', () => {
    const env = parseStatusEnv('API_URL="http://127.0.0.1:54321"\nANON_KEY="abc.def"\r\nJWT_SECRET=plain\nnoise line');
    assert.deepEqual(env, { API_URL: 'http://127.0.0.1:54321', ANON_KEY: 'abc.def', JWT_SECRET: 'plain' });
  });

  it('signs an HS256 token the secret verifies', () => {
    const token = signJwt({ sub: 'x', role: 'authenticated' }, 'secret');
    const [head, body, signature] = token.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url').toString()), { alg: 'HS256', typ: 'JWT' });
    assert.deepEqual(JSON.parse(Buffer.from(body, 'base64url').toString()), { sub: 'x', role: 'authenticated' });
    assert.equal(signature, createHmac('sha256', 'secret').update(`${head}.${body}`).digest('base64url'));
  });
});

describe('check-view-embeds: public embed reads (embedReads.json)', () => {
  it('has a seed filter for every read in embedReads.json, and no stale ones', () => {
    assert.deepEqual(Object.keys(EMBED_FILTERS).sort(), Object.keys(embedReads).sort());
  });

  it('calls the wet-flags read as anon and admin, on the seeded round, with the select encoded once', () => {
    const calls = plannedCalls(embedReads, EMBED_FILTERS, 'embedReads.json').filter((c) => c.name === 'raceWetFlags');
    const url = `curated_rounds?select=${encodeURIComponent(embedReads.raceWetFlags.select)}&subsession_id=eq.9907001`;
    assert.deepEqual(
      calls.map((c) => [c.name, c.caller, c.url, c.source]),
      [
        ['raceWetFlags', 'anon', url, 'embedReads.json'],
        ['raceWetFlags', 'admin', url, 'embedReads.json'],
      ],
    );
  });

  it('calls the rating timeline read as anon and admin, on the seeded round, with the select encoded once', () => {
    const calls = plannedCalls(embedReads, EMBED_FILTERS, 'embedReads.json').filter(
      (c) => c.name === 'ratingTimelineRounds',
    );
    const url = `curated_rounds?select=${encodeURIComponent(embedReads.ratingTimelineRounds.select)}&subsession_id=eq.9907001`;
    assert.deepEqual(
      calls.map((c) => [c.name, c.caller, c.url, c.source]),
      [
        ['ratingTimelineRounds', 'anon', url, 'embedReads.json'],
        ['ratingTimelineRounds', 'admin', url, 'embedReads.json'],
      ],
    );
    assert.deepEqual(calls[0].embeds, ['season', 'event', 'pinned_events']);
  });

  it('passes only the seeded timeline values: the Embed Season, an exhibition linked event, a test pinned one', () => {
    const check = EMBED_EXPECT.ratingTimelineRounds;
    const good = {
      subsession_id: 9907001,
      season: { name: 'Embed Season' },
      event: { category: 'exhibition' },
      pinned_events: [{ category: 'test' }],
    };
    assert.equal(check([good]), null);
    assert.match(check([{ ...good, season: { name: 'ATC18' } }]), /season/);
    assert.match(check([{ ...good, event: null }]), /event/);
    assert.match(
      check([{ ...good, event: { category: 'test' }, pinned_events: [{ category: 'exhibition' }] }]),
      /event category/,
    );
    assert.match(check([{ ...good, pinned_events: [] }]), /pinned_events/);
  });

  it('calls the past results read as anon and admin, on the seeded round, with the select encoded once', () => {
    const calls = plannedCalls(embedReads, EMBED_FILTERS, 'embedReads.json').filter(
      (c) => c.name === 'pastResultsRoundEvents',
    );
    const url = `curated_rounds?select=${encodeURIComponent(embedReads.pastResultsRoundEvents.select)}&subsession_id=eq.9907001`;
    assert.deepEqual(
      calls.map((c) => [c.name, c.caller, c.url, c.source]),
      [
        ['pastResultsRoundEvents', 'anon', url, 'embedReads.json'],
        ['pastResultsRoundEvents', 'admin', url, 'embedReads.json'],
      ],
    );
    assert.deepEqual(calls[0].embeds, ['event', 'pinned_events']);
  });

  it('passes only the seeded past results categories: an exhibition linked event, a test pinned one', () => {
    const check = EMBED_EXPECT.pastResultsRoundEvents;
    const good = { subsession_id: 9907001, event: { category: 'exhibition' }, pinned_events: [{ category: 'test' }] };
    assert.equal(check([good]), null);
    assert.match(check([{ ...good, event: { category: 'championship' } }]), /event category/);
    assert.match(check([{ ...good, event: null }]), /event category/);
    assert.match(check([{ ...good, pinned_events: [] }]), /pinned_events/);
  });

  it('seeds the season before the round, links the round to it, and gives the events their categories', () => {
    const seasonAt = SEED_SQL.indexOf('insert into public.seasons');
    const roundAt = SEED_SQL.indexOf('insert into public.curated_rounds');
    assert.ok(seasonAt > -1 && roundAt > seasonAt);
    assert.match(SEED_SQL, /insert into public\.seasons \(id, number, name\) values \('[^']+', 990701, 'Embed Season'\);/);
    assert.match(SEED_SQL, /insert into public\.curated_rounds \(subsession_id, start_time, track_name, event_id, season_id\)/);
    assert.match(SEED_SQL, /insert into public\.events \(id, event_date, race1_wet_affected, category\) values \('[^']+', '2026-06-01', true, 'exhibition'\);/);
    assert.match(SEED_SQL, /9907001, false, 'test'\);/);
  });

  it('deletes the season after the round and the rating steps, and the events before the round', () => {
    const seasonDeleteAt = CLEANUP_SQL.indexOf('delete from public.seasons');
    const roundDeleteAt = CLEANUP_SQL.indexOf('delete from public.curated_rounds');
    const stepsDeleteAt = CLEANUP_SQL.indexOf('delete from private.rating_steps');
    const eventsDeleteAt = CLEANUP_SQL.indexOf('delete from public.events');
    assert.ok(stepsDeleteAt > -1 && roundDeleteAt > -1);
    assert.ok(seasonDeleteAt > roundDeleteAt && seasonDeleteAt > stepsDeleteAt);
    assert.ok(eventsDeleteAt > -1 && roundDeleteAt > eventsDeleteAt);
  });

  it('names the reads file when a read has no seed filter', () => {
    const extra = { extra: { path: 'x', select: 'id', embeds: [], callers: ['anon'] } };
    assert.throws(() => plannedCalls(extra, {}, 'embedReads.json'), /embedReads\.json entry "extra"/);
    assert.throws(() => plannedCalls(extra, {}), /privacyReads\.json entry "extra"/);
  });

  it('passes only the seeded wet flags: linked race 1 wet, pinned race 1 dry', () => {
    const check = EMBED_EXPECT.raceWetFlags;
    assert.equal(check([{ linked: { race1_wet_affected: true }, pinned: [{ id: 'x', race1_wet_affected: false }] }]), null);
    assert.match(
      check([{ linked: { race1_wet_affected: false }, pinned: [{ id: 'x', race1_wet_affected: true }] }]),
      /linked/,
    );
    assert.match(check([{ linked: { race1_wet_affected: true }, pinned: [] }]), /pinned/);
    assert.match(check([{ linked: null, pinned: [{ id: 'x', race1_wet_affected: false }] }]), /linked/);
  });

  it('seeds the linked event before the round and the pinned one after, and deletes both before the round', () => {
    const linkedAt = SEED_SQL.indexOf('insert into public.events (id, event_date, race1_wet_affected');
    const roundAt = SEED_SQL.indexOf('insert into public.curated_rounds');
    const pinnedAt = SEED_SQL.indexOf('insert into public.events (id, event_date, subsession_id');
    assert.ok(linkedAt > -1 && roundAt > linkedAt && pinnedAt > roundAt);
    const eventsDeleteAt = CLEANUP_SQL.indexOf('delete from public.events');
    const roundDeleteAt = CLEANUP_SQL.indexOf('delete from public.curated_rounds');
    assert.ok(eventsDeleteAt > -1 && roundDeleteAt > eventsDeleteAt);
  });
});
