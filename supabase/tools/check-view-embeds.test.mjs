// Tests for the pure parts of check-view-embeds.mjs. No database or network is used.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { FILTERS, embedProblem, parseStatusEnv, plannedCalls, signJwt } from './check-view-embeds.mjs';

const reads = JSON.parse(readFileSync(new URL('../../src/lib/privacyReads.json', import.meta.url), 'utf8'));

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
