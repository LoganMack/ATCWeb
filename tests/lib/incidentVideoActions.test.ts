/**
 * The clip and turn page actions (BR3.1, BR3.2, BR4.1-BR4.3, BR5.1): set-report-video and set-incident-video
 * check the link before calling the database and never put it in the redirect; Add Incident copies the turn
 * and clip onto every row it creates, and a turn over 80 characters is refused before anything is written.
 * fetch is stubbed, so nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncidentActionContext } from '../../src/lib/incidentActions/context';
import { handleSetIncidentVideo, handleSetReportVideo } from '../../src/lib/incidentActions/setVideo';
import { handleSaveIncident, readIncidentTurnAndClip } from '../../src/lib/incidentActions/saveIncident';

const env = { url: 'https://project.example.test', anonKey: 'anon-key' };

function ctx(): IncidentActionContext {
  return {
    supabaseEnv: env,
    subsessionId: 555,
    shellPath: '/results/555/incidents',
    url: new URL('https://site.example.test/results/555/incidents/fragment?view=reports'),
    session: null,
    accessToken: 'steward-token',
    actor: { id: 'u1', name: 'Steward' },
    roundLabel: 'Zk Park (1 Jun 2026)',
    redirect: (location) => ({ location, status: 302 }),
  };
}

function form(entries: [string, string][]) {
  const data = new FormData();
  for (const [k, v] of entries) data.append(k, v);
  return data;
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}
let calls: Call[];

/** Records every request; RPCs answer `rpcAnswer`, inserts echo an id, everything else an empty list. */
function stubFetch(rpcAnswer: () => Response = () => new Response('{}', { status: 200 })) {
  calls = [];
  let id = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes('/rpc/')) return rpcAnswer();
      if (method === 'POST' && url.endsWith('/rest/v1/penalties')) {
        return new Response(JSON.stringify([{ id: `p${++id}` }]), { status: 201 });
      }
      return new Response('[]', { status: 200 });
    }),
  );
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  stubFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rpcCalls = () => calls.filter((c) => c.url.includes('/rpc/'));

describe('set-report-video', () => {
  it('refuses a bad link without calling the database, and keeps the link out of the URL', async () => {
    const result = await handleSetReportVideo(
      ctx(),
      form([
        ['report_id', 'r1'],
        ['video_url', 'javascript:alert(1)'],
      ]),
    );
    expect(calls).toHaveLength(0);
    const location = new URL(result.location, 'https://site.example.test');
    expect(location.pathname).toBe('/results/555/incidents');
    expect(location.searchParams.get('video')).toBe('invalid');
    expect(location.searchParams.get('video_for')).toBe('report:r1');
    expect(result.location).not.toMatch(/javascript|alert/);
  });

  it('clears the clip with an empty box', async () => {
    const result = await handleSetReportVideo(
      ctx(),
      form([
        ['report_id', 'r1'],
        ['video_url', '   '],
      ]),
    );
    expect(rpcCalls()).toEqual([
      {
        url: 'https://project.example.test/rest/v1/rpc/set_incident_report_video',
        method: 'POST',
        body: { p_report_id: 'r1', p_url: '' },
      },
    ]);
    expect(result.location).toMatch(/[?&]video=cleared/);
    expect(result.location).toMatch(/#reported-incidents$/);
  });
});

describe('set-incident-video', () => {
  it("sends a good link with the incident's identity", async () => {
    const result = await handleSetIncidentVideo(
      ctx(),
      form([
        ['session', 'race:2'],
        ['incident_number', ' 7 '],
        ['video_url', ' https://youtu.be/abc '],
      ]),
    );
    expect(rpcCalls().map((c) => [c.url.split('/rpc/')[1], c.body])).toEqual([
      [
        'set_incident_video',
        {
          p_subsession_id: 555,
          p_session_type: 'race',
          p_race_number: 2,
          p_incident_number: '7',
          p_url: 'https://youtu.be/abc',
        },
      ],
    ]);
    expect(result.location).toMatch(/[?&]video=saved/);
  });

  it('refuses an incident with no number before calling the database', async () => {
    const result = await handleSetIncidentVideo(
      ctx(),
      form([
        ['session', 'qualifying:0'],
        ['incident_number', '  '],
        ['video_url', 'https://youtu.be/abc'],
      ]),
    );
    expect(calls).toHaveLength(0);
    expect(result.location).toMatch(/[?&]video=nonumber/);
  });

  it("shows the database's refusal as a plain message code", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ code: 'P0001', message: 'INCIDENT_NOT_FOUND: That incident no longer exists' }),
          {
            status: 400,
          },
        ),
    );
    const result = await handleSetIncidentVideo(
      ctx(),
      form([
        ['session', 'race:1'],
        ['incident_number', '99'],
        ['video_url', 'https://youtu.be/abc'],
      ]),
    );
    expect(result.location).toMatch(/[?&]video=notfound/);
    // Nothing is logged for a write that didn't happen.
    expect(calls.some((c) => c.url.includes('activity_log'))).toBe(false);
  });
});

describe('Add and Edit Incident: turn and clip', () => {
  it('refuses a turn over 80 characters before writing anything', async () => {
    expect(readIncidentTurnAndClip(form([['turn', 't'.repeat(80)]]), 'add-incident').ok).toBe(true);
    const result = await handleSaveIncident(
      ctx(),
      form([
        ['session', 'race:1'],
        ['turn', 't'.repeat(81)],
      ]),
      'add-incident',
    );
    expect(calls).toHaveLength(0);
    expect(result.location).toMatch(/[?&]incident=turn/);
  });

  it('refuses a bad copied clip before writing anything', async () => {
    const result = await handleSaveIncident(
      ctx(),
      form([
        ['session', 'race:1'],
        ['video_url', 'data:text/html,x'],
      ]),
      'add-incident',
    );
    expect(calls).toHaveLength(0);
    expect(result.location).toMatch(/[?&]incident=video/);
  });

  it('copies the trimmed turn and the clip onto every row Add to Report creates', async () => {
    await handleSaveIncident(
      ctx(),
      form([
        ['session', 'race:1'],
        ['incident_number', '3'],
        ['turn', '  T4  '],
        ['video_url', 'https://cdn.discordapp.com/a/b.mp4'],
        ['fault_driver_ids', 'd1'],
        ['fault_driver_ids', 'd2'],
        ['from_report_id', 'r1'],
      ]),
      'add-incident',
    );
    const inserts = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/rest/v1/penalties'));
    expect(inserts).toHaveLength(2);
    for (const insert of inserts) {
      expect(insert.body).toMatchObject({ turn: 'T4', video_url: 'https://cdn.discordapp.com/a/b.mp4' });
    }
  });

  it('saves the turn on an edit but leaves the clip to its own Add/Edit Video', async () => {
    await handleSaveIncident(
      ctx(),
      form([
        ['session', 'race:1'],
        ['penalty_id', 'p9'],
        ['turn', ''],
        ['video_url', 'https://youtu.be/other'],
      ]),
      'update-incident',
    );
    const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/rest/v1/penalties?id=eq.p9'));
    expect(patch?.body).toMatchObject({ turn: null });
    expect(patch?.body).not.toHaveProperty('video_url');
  });
});
