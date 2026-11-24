/**
 * The readers after the driver privacy expand step (U4, BR9.13, BR9.14, NFR2.1, NFR3.1, NFR9.1): every public
 * reader asks the masked *_shown view for the same columns it asked the table for, a signed-in request reads
 * with its own token, an admin page reads with the admin's, and nothing adds a call. fetch is stubbed; no
 * network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getDriverProfileById,
  getDrivers,
  getNewsPostBySlug,
  getNewsPosts,
  resolveSupabaseEnv,
  type SupabaseEnv,
} from '../../src/lib/db/client';
import {
  getDriversBasic,
  getDriverById,
  getHallOfFameDrivers,
  getShownDriversByIds,
} from '../../src/lib/db/drivers';
import { getAllNewsPostDrivers, getDriversForPost } from '../../src/lib/db/news';
import { getAllMeetupDriverLinks } from '../../src/lib/db/media';
import { getPenaltiesForDriver, getPenaltiesForSubsession } from '../../src/lib/db/penalties';
import { getAllCircuitLayouts } from '../../src/lib/db/circuits';
import { getAllHallOfFamePhotos, getChampionPhotosForClass } from '../../src/lib/db/photos';
import { getKudosForSubsession, getKudosForSubsessions, getKudosInvolvingDriver } from '../../src/lib/kudos';
import { getMemberInterviews } from '../../src/lib/interviewsFeed';
import privacyReads from '../../src/lib/privacyReads.json';
import { getRoundPenaltiesForDriver } from '../../src/lib/roundPenalties';
import { getProfile } from '../../src/lib/auth';
import { driversSelect } from '../../src/lib/results/rows';
import { getQualifyingForSubsession } from '../../src/lib/results/sessions';
import { findProfileDriver, loadDriverAwards, loadDriverPage } from '../../src/lib/driverPage/load';
import { RequestMemo } from '../../src/lib/requestMemo';
import { ROUND_WET_FLAGS_SELECT } from '../../src/lib/db/events';
import embedReads from '../../src/lib/embedReads.json';
import { EMBED_FILTERS } from '../../supabase/tools/check-view-embeds.mjs';

const blocked = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = blocked;
  vi.restoreAllMocks();
});

const RUNTIME = {
  env: { PUBLIC_SUPABASE_URL: 'https://db.example.test', PUBLIC_SUPABASE_ANON_KEY: 'anon-key' },
};
const DRIVER_ID = '99999999-0000-0000-0000-000000000601';

interface Call {
  path: string;
  table: string;
  select: string;
  auth: string | null;
}

/** Records every REST call and answers each with `answer(table, path)` (default: an empty list). */
function stubFetch(answer: (table: string, path: string) => unknown = () => []): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname.split('/rest/v1/')[1] + url.search);
    const table = path.split('?')[0];
    calls.push({
      path,
      table,
      select: url.searchParams.get('select') ?? '',
      auth: new Headers(init?.headers).get('Authorization'),
    });
    return new Response(JSON.stringify(answer(table, path)), { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

function locals(extra: Record<string, unknown> = {}): App.Locals {
  return { runtime: RUNTIME, session: null, viewAsVisitor: false, ...extra } as unknown as App.Locals;
}

const signedIn = (token: string) => ({ session: { user: { id: 'u1' }, profile: null, accessToken: token } });
const anonEnv = (): SupabaseEnv => resolveSupabaseEnv(locals());

describe('read env (BR9.13, NFR2.1)', () => {
  it('reads with the anon key when signed out and with the viewer’s own token when signed in', async () => {
    expect(resolveSupabaseEnv(locals()).accessToken).toBeUndefined();
    expect(resolveSupabaseEnv(locals(signedIn('viewer-jwt'))).accessToken).toBe('viewer-jwt');

    const calls = stubFetch();
    await getDrivers(resolveSupabaseEnv(locals()));
    await getDrivers(resolveSupabaseEnv(locals(signedIn('viewer-jwt'))));
    expect(calls.map((c) => c.auth)).toEqual(['Bearer anon-key', 'Bearer viewer-jwt']);
  });

  it('reads as a visitor during an admin’s View as Visitor, but never on /admin', async () => {
    const calls = stubFetch();
    const visitor = resolveSupabaseEnv(
      locals({ ...signedIn('admin-jwt'), viewAsVisitor: true, readAsVisitor: true }),
    );
    const adminPage = resolveSupabaseEnv(
      locals({ ...signedIn('admin-jwt'), viewAsVisitor: true, readAsVisitor: false }),
    );
    await getDrivers(visitor);
    await getDriversBasic(adminPage);
    expect(calls.map((c) => c.auth)).toEqual(['Bearer anon-key', 'Bearer admin-jwt']);
  });

  it('keeps the per-request memo per request (NFR2.3)', () => {
    const memo = new RequestMemo();
    expect(resolveSupabaseEnv(locals({ ...signedIn('t'), memo })).memo).toBe(memo);
  });
});

describe('public readers use the masked views with the same columns (BR9.14, NFR3.1)', () => {
  it('reads the roster and the profile from drivers_shown, with the old columns plus the flags', async () => {
    const calls = stubFetch();
    await getDrivers(anonEnv());
    await getDriverProfileById(anonEnv(), DRIVER_ID);
    expect(calls.map((c) => c.table)).toEqual(['drivers_shown', 'drivers_shown']);
    for (const col of ['id', 'car_number', 'name', 'penalty_points_max', 'nationality_2', 'is_hidden']) {
      expect(calls[0].select.split(',')).toContain(col);
    }
    expect(calls[0].select).toContain('teams!drivers_team_id_fkey(name,primary_color_hex,logo_url)');
    expect(calls[1].select).toContain('profile_private');
    expect(calls[1].select).toContain('bio,photo_url');
  });

  it('reads news, penalties, round penalties, kudos, layouts and photos from their views', async () => {
    const calls = stubFetch();
    const env = anonEnv();
    await getNewsPosts(env);
    await getNewsPostBySlug(env, 'a-post');
    await getPenaltiesForSubsession(env, 1);
    await getRoundPenaltiesForDriver(env, 1, DRIVER_ID);
    await getKudosForSubsession(env, 1);
    await getAllCircuitLayouts(env);
    await getChampionPhotosForClass(env, 1);
    await getAllHallOfFamePhotos(env);
    await getHallOfFameDrivers(env);
    expect(calls.map((c) => c.table)).toEqual([
      'news_posts_shown',
      'news_posts_shown',
      'penalties_shown',
      'round_penalties_shown',
      'kudos_shown',
      'circuit_layouts_shown',
      'champion_photos_shown',
      'hall_of_fame_photos_shown',
      'drivers_shown',
    ]);
    expect(calls[2].select).toContain(
      'penalty_offense_links(offense_id),penalty_involved_drivers(driver_id)',
    );
    expect(calls[4].select).toBe('*,kudos_drivers(driver_id)');
  });

  it('embeds drivers_shown under the old key, so callers read the same shape', async () => {
    const calls = stubFetch((table) =>
      table === 'news_post_drivers'
        ? [
            {
              post_id: 'p',
              drivers: { id: DRIVER_ID, name: 'Hidden Driver', car_number: 7, is_hidden: true },
            },
          ]
        : [],
    );
    const tagged = await getDriversForPost(anonEnv(), 'p');
    await getAllNewsPostDrivers(anonEnv());
    await getAllMeetupDriverLinks(anonEnv());
    expect(tagged).toEqual([{ id: DRIVER_ID, name: 'Hidden Driver', car_number: 7, is_hidden: true }]);
    expect(calls.map((c) => c.select)).toEqual([
      'post_id,drivers:drivers_shown(id,name,car_number,is_hidden)',
      'post_id,drivers:drivers_shown(id,name,car_number,is_hidden)',
      'meetup_id,driver_id,drivers:drivers_shown(name,car_number,is_hidden)',
    ]);
  });

  it('reads kudos across rounds and members’ interviews through their views (driver-profile-polish)', async () => {
    const calls = stubFetch();
    await getKudosInvolvingDriver(anonEnv(), DRIVER_ID);
    await getKudosForSubsessions(anonEnv(), [1]);
    await getMemberInterviews(anonEnv(), 'member-jwt', [1]);
    expect(calls.map((c) => c.table)).toEqual(['kudos_shown', 'kudos_shown', 'race_interviews_shown']);
    expect(calls[0].select).toBe(
      '*,kudos_drivers(driver_id,drivers:drivers_shown(id,name,car_number,is_hidden)),involved_match:kudos_drivers!inner(driver_id)',
    );
    expect(calls[1].select).toBe(
      '*,kudos_drivers(driver_id,drivers:drivers_shown(id,name,car_number,is_hidden))',
    );
    expect(calls[2].select).toBe(
      'id,subsession_id,driver_id,duration_seconds,created_at,drivers:drivers_shown(id,name,car_number,is_hidden)',
    );
    expect(calls[2].auth).toBe('Bearer member-jwt');
  });

  it('never reads interviews anonymously: the read is listed for members and admins only', () => {
    expect(privacyReads.interviewsShown.callers).toEqual(['member', 'admin']);
    expect(privacyReads.kudosInvolving.callers).toEqual(['anon', 'admin']);
    expect(privacyReads.kudosFeed.callers).toEqual(['anon', 'admin']);
  });

  it('keeps the broadcaster filter on the masked results and penalties views', async () => {
    const calls = stubFetch();
    const env = { ...anonEnv(), hiddenSubsessionIds: [42] };
    await getPenaltiesForDriver(env, DRIVER_ID);
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.path).toContain('subsession_id=not.in.(42)');
    expect(calls[1].select).toContain('involved_match:penalty_involved_drivers!inner(driver_id)');
  });

  it('makes one call per reader, never one per row', async () => {
    const calls = stubFetch((table) =>
      table === 'drivers_shown'
        ? Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, name: `D ${i}` }))
        : [],
    );
    await getDrivers(anonEnv());
    await driversSelect(anonEnv());
    expect(calls).toHaveLength(2);
  });
});

describe('Lineup Changes names (lineup-changes BR1.15, NFR3.1)', () => {
  it('reads drivers_shown with the pinned select in one call, and nothing for no ids', async () => {
    const calls = stubFetch();
    await getShownDriversByIds(anonEnv(), []);
    expect(calls).toHaveLength(0);
    await getShownDriversByIds(anonEnv(), [DRIVER_ID, 'a b', DRIVER_ID]);
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe('drivers_shown');
    expect(calls[0].select).toBe('id,name,car_number,is_hidden');
    expect(calls[0].select).toBe(privacyReads.lineupDrivers.select);
    expect(calls[0].path).toContain(`&id=in.(${DRIVER_ID},a b)`);
    expect(privacyReads.lineupDrivers).toMatchObject({
      path: 'drivers_shown',
      embeds: [],
      callers: ['anon', 'admin'],
    });
  });
});

describe('public embed reads checked in CI (driver-splits NFR3.3, NFR7.7)', () => {
  it('gives every embedReads.json entry a seed filter, and pins the wet-flags entry', () => {
    for (const name of Object.keys(embedReads)) expect(EMBED_FILTERS).toHaveProperty(name);
    expect(embedReads.raceWetFlags).toMatchObject({
      path: 'curated_rounds',
      embeds: ['linked', 'pinned'],
      callers: ['anon', 'admin'],
    });
  });

  it('pins the Series iRating timeline entry (irating-chart NFR3.3, NFR7.8)', () => {
    expect(embedReads.ratingTimelineRounds).toMatchObject({
      path: 'curated_rounds',
      embeds: ['season', 'event', 'pinned_events'],
      callers: ['anon', 'admin'],
    });
  });

  it('pins the past-results round events entry (past-results NFR3.2, NFR7.7)', () => {
    expect(embedReads.pastResultsRoundEvents).toMatchObject({
      path: 'curated_rounds',
      embeds: ['event', 'pinned_events'],
      callers: ['anon', 'admin'],
    });
    expect(EMBED_FILTERS).toHaveProperty('pastResultsRoundEvents');
  });
});

describe('results join through the stand-in customer id (BR9.4, F2 A)', () => {
  it('pairs a hidden driver’s masked row with its roster driver and keeps the unrostered fallback', async () => {
    const hidden = {
      id: DRIVER_ID,
      name: 'Hidden Driver',
      car_number: 7,
      photo_url: null,
      iracing_cust_id: -123456789,
      is_rookie: false,
      nationality_1: null,
      nationality_2: null,
      is_ai: false,
      is_hidden: true,
    };
    stubFetch((table) => {
      if (table === 'curated_qualifying_shown')
        return [
          {
            subsession_id: 1,
            cust_id: -123456789,
            display_name: 'Hidden Driver',
            car_class_name: null,
            qual_position: 1,
            best_lap_ten_thousandths: null,
          },
          {
            subsession_id: 1,
            cust_id: 555,
            display_name: 'Una Rostered',
            car_class_name: null,
            qual_position: 2,
            best_lap_ten_thousandths: null,
          },
        ];
      if (table === 'drivers_shown') return [hidden];
      return [];
    });
    const { overall } = await getQualifyingForSubsession(anonEnv(), 1);
    expect(overall[0]).toMatchObject({
      notInRoster: false,
      driver: { id: DRIVER_ID, name: 'Hidden Driver', is_hidden: true },
    });
    expect(overall[1]).toMatchObject({
      notInRoster: true,
      driver: { id: 'unrostered:555', name: 'Una Rostered' },
    });
  });
});

describe('the signed-in profile and the private profile (BR9.11, BR9.12)', () => {
  it('still gives a linked user their driver name, through drivers_shown with their own token', async () => {
    const calls = stubFetch(() => [
      {
        id: 'u1',
        role: 'driver',
        display_name: 'U',
        driver_id: DRIVER_ID,
        iracing_cust_id: null,
        iracing_name: null,
        driver: { name: 'Real Name' },
      },
    ]);
    const profile = await getProfile(anonEnv(), 'user-jwt', 'u1');
    expect(profile?.driver_name).toBe('Real Name');
    expect(calls[0].select).toContain('driver:drivers_shown!driver_id(name)');
    expect(calls[0].auth).toBe('Bearer user-jwt');
  });

  it('reads nothing past the driver check for a private profile, and logs nothing', async () => {
    const error = vi.spyOn(console, 'error');
    const calls = stubFetch((table) =>
      table === 'drivers_shown'
        ? [{ id: DRIVER_ID, iracing_cust_id: null, is_hall_of_fame: false, profile_private: true }]
        : [],
    );
    const page = await loadDriverPage(anonEnv(), DRIVER_ID);
    const awards = await loadDriverAwards(anonEnv(), DRIVER_ID);
    expect(page).toMatchObject({
      notFound: false,
      privateProfile: true,
      loadError: null,
      raceHistory: [],
      career: null,
    });
    expect(awards).toMatchObject({ notFound: false, privateProfile: true, awardEntries: [] });
    // The light reference reads start beside the driver check (as for an unknown id); none of the
    // profile's own data is read.
    const heavy = calls
      .map((c) => c.table)
      .filter((t) =>
        [
          'race_score_results_public',
          'penalties_shown',
          'news_posts_shown',
          'news_post_drivers',
          'round_driver_stats',
          'curated_race_results_shown',
        ].includes(t),
      );
    expect(heavy).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it('reads layouts from the view and wet flags in one call, and a failed wet read is no load error (driver-splits NFR1.1, NFR2.2, NFR3.2)', async () => {
    const driver = {
      id: DRIVER_ID,
      name: 'Public Driver',
      iracing_cust_id: 777,
      is_hall_of_fame: false,
      profile_private: false,
      is_ai: false,
    };
    const race = {
      subsession_id: 1,
      race_number: 1,
      driver_id: DRIVER_ID,
      season_id: 's1',
      class_id: 1,
      team_id: null,
      finish_position: 1,
      classified: true,
      dsq: false,
      raw_position: 1,
      shown_set: 'raw',
      shown_position: 1,
      shown_class_position: 1,
    };
    const raw = { subsession_id: 1, race_number: 1, cust_id: 777, finish_position: 1, laps_complete: 5 };
    const answer = (table: string) => {
      if (table === 'drivers_shown') return [driver];
      if (table === 'race_score_results_public') return [race];
      if (table === 'curated_race_results_shown') return [raw];
      return [];
    };
    const run = async (wetStatus: number) => {
      const calls: Call[] = [];
      globalThis.fetch = (async (input: string) => {
        const url = new URL(String(input));
        const path = decodeURIComponent(url.pathname.split('/rest/v1/')[1] + url.search);
        const table = path.split('?')[0];
        const select = url.searchParams.get('select') ?? '';
        calls.push({ path, table, select, auth: null });
        if (table === 'curated_rounds' && select === ROUND_WET_FLAGS_SELECT && wetStatus !== 200)
          return new Response('upstream failure', { status: wetStatus });
        return new Response(JSON.stringify(answer(table)), { status: 200 });
      }) as unknown as typeof fetch;
      return { calls, page: await loadDriverPage(anonEnv(), DRIVER_ID) };
    };

    const ok = await run(200);
    const tables = ok.calls.map((c) => c.table);
    expect(tables).toContain('circuit_layouts_shown');
    expect(tables).not.toContain('circuit_layouts');
    expect(
      ok.calls.filter((c) => c.table === 'curated_rounds' && c.select === ROUND_WET_FLAGS_SELECT),
    ).toHaveLength(1);
    expect(ok.page.raceHistory).toHaveLength(1);
    expect(ok.page.raceHistory[0].wetAffected).toBe(false);

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = await run(500);
    expect(failed.page.loadError).toBeNull();
    expect(failed.page.raceHistory).toHaveLength(1);
    expect(failed.page.raceHistory[0].wetAffected).toBeNull();
  });

  it('asks drivers_shown for profile_private in the driver check', async () => {
    const calls = stubFetch(() => [
      { id: DRIVER_ID, iracing_cust_id: 1, is_hall_of_fame: false, profile_private: false },
    ]);
    expect(await findProfileDriver(anonEnv(), DRIVER_ID)).toMatchObject({ profile_private: false });
    expect(calls[0].table).toBe('drivers_shown');
    expect(calls[0].select).toBe('id,name,iracing_cust_id,is_hall_of_fame,profile_private');
  });
});

describe('admin readers (BR9.13, W5)', () => {
  it('read the base drivers table with the admin’s token on admin pages', async () => {
    const calls = stubFetch();
    const env = resolveSupabaseEnv(locals(signedIn('admin-jwt')));
    await getDriversBasic(env);
    await getDriverById(env, DRIVER_ID);
    expect(calls.map((c) => `${c.table} ${c.auth}`)).toEqual([
      'drivers Bearer admin-jwt',
      'drivers Bearer admin-jwt',
    ]);
  });

  it('never log a driver name when a masked read fails (NFR9.1)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    globalThis.fetch = (async () =>
      new Response('upstream failure', { status: 500 })) as unknown as typeof fetch;
    await expect(getDrivers(anonEnv())).rejects.toThrow(/Supabase REST error 500 on drivers_shown/);
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toMatch(/Hidden Driver|hide_name|hide_profile/);
  });
});
