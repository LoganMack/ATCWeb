import { getNewsPosts, restGet, type NewsPost, type SupabaseEnv } from '../db/client';
import { getDriverClasses } from '../db/lookups';
import { getSeasons, type Season, type SeasonLogoPair } from '../db/seasons';
import { getStandingsExcludedRoundIds } from '../db/rounds';
import { getManualAwards } from '../db/awards';
import { getAllNewsPostDrivers, getAllNewsPostTags, type NewsTag } from '../db/news';
import { computeDriverCareer, loadCareerRefs, type DriverCareerStats } from '../results/careerStats';
import { getDriverRaceHistory, type DriverRaceHistoryRow } from '../results/raceHistory';
import { computeSeasonAwardsHistory } from '../results/awards';
import { getIncidentsForDriver, type IncidentRow } from '../incidents';
import { trimNum, signedNum, type AwardEntry, type CareerMove, type ClassMove } from './helpers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProfileDriver {
  id: string;
  iracing_cust_id: number | null;
  is_hall_of_fame: boolean;
  /** drivers_shown (U4, BR9.11): the profile is private for this caller, so nothing else is read. */
  profile_private?: boolean;
}

/** The profile's driver, or null when the id isn't a UUID or names no (non-AI) driver; checked first. */
export async function findProfileDriver(
  supabaseEnv: SupabaseEnv,
  driverId: string,
): Promise<ProfileDriver | null> {
  if (!UUID.test(driverId)) return null;
  const rows = await restGet<ProfileDriver[]>(
    supabaseEnv,
    `drivers_shown?select=id,iracing_cust_id,is_hall_of_fame,profile_private&id=eq.${encodeURIComponent(driverId)}&is_ai=eq.false`,
  );
  return rows[0] ?? null;
}

/** The light reads a career needs, started alongside the driver check. */
function loadCareerInputs(supabaseEnv: SupabaseEnv) {
  const base = Promise.all([
    getDriverClasses(supabaseEnv),
    getSeasons(supabaseEnv),
    getStandingsExcludedRoundIds(supabaseEnv),
    loadCareerRefs(supabaseEnv),
  ]);
  // Awaited by the caller once the driver is known; this only keeps an early failure from going unhandled.
  base.catch(() => undefined);
  return base;
}

/**
 * One driver's career from the stored round stats of the seasons they raced (BR1.1), with every season
 * whose stored rows are not current added, so a profile is never empty before the backfill.
 */
function loadCareer(supabaseEnv: SupabaseEnv, driverId: string, base: ReturnType<typeof loadCareerInputs>) {
  const career = base.then(([classes, seasons, excludedIds, refs]) =>
    computeDriverCareer(supabaseEnv, driverId, seasons, classes, excludedIds, refs),
  );
  return { seasons: base.then(([, seasons]) => seasons), career };
}

/**
 * Everything the driver profile fragment fetches, except the awards (loadDriverAwards, its own cached
 * fragment). `notFound` when the id isn't a known driver, checked before any heavy read. A failure of the
 * career or the race history sets loadError (the page then renders its error state and is not cached);
 * news and incidents fail on their own, leaving their lists empty.
 */
export async function loadDriverPage(supabaseEnv: SupabaseEnv, driverId: string) {
  let notFound = false;
  let privateProfile = false;
  let loadError: string | null = null;
  let career: DriverCareerStats | null = null;
  let raceHistory: DriverRaceHistoryRow[] = [];

  // Related News: posts that tag this driver or link a round they raced.
  let relatedPosts: NewsPost[] = [];
  let relatedLogoBySeasonLabel = new Map<string, SeasonLogoPair>();
  const relatedTagsByPostId = new Map<string, NewsTag[]>();

  const careerMoves: CareerMove[] = [];
  const classMoves: ClassMove[] = [];

  const empty = () => ({
    notFound,
    privateProfile,
    loadError,
    career,
    raceHistory,
    relatedPosts,
    relatedLogoBySeasonLabel,
    relatedTagsByPostId,
    careerMoves,
    classMoves,
    driverIncidents: [] as IncidentRow[],
  });

  // Stage 1: the driver check alongside the light career reads; nothing heavy runs for an unknown id, and
  // nothing at all for an id that isn't a UUID.
  if (!UUID.test(driverId)) {
    notFound = true;
    return empty();
  }
  const base = loadCareerInputs(supabaseEnv);
  let driver: Awaited<ReturnType<typeof findProfileDriver>> = null;
  try {
    driver = await findProfileDriver(supabaseEnv, driverId);
  } catch (err) {
    console.error('Failed to look up the profile driver:', err);
    loadError = err instanceof Error ? err.message : String(err);
    return empty();
  }
  if (!driver) {
    notFound = true;
    return empty();
  }
  // A private profile (BR9.11): none of its data is read.
  if (driver.profile_private) {
    privateProfile = true;
    return empty();
  }

  // Then in parallel: the career, the race history, the news and the driver's own incidents (BR4.2).
  const { seasons: seasonsPromise, career: careerPromise } = loadCareer(supabaseEnv, driverId, base);
  const historyPromise = getDriverRaceHistory(supabaseEnv, driverId, driver.iracing_cust_id);
  const newsPromise = Promise.all([
    getNewsPosts(supabaseEnv),
    getAllNewsPostDrivers(supabaseEnv),
    getAllNewsPostTags(supabaseEnv),
  ]).catch((err) => {
    console.error('Failed to load related news for driver profile:', err);
    return null;
  });
  // Only this driver's incidents, filtered in the database (BR1.2).
  const incidentsPromise = getIncidentsForDriver(supabaseEnv, driverId).catch((err) => {
    console.error('Failed to load incident history for driver profile:', err);
    return [] as IncidentRow[];
  });

  try {
    const [careerResult, history, seasons] = await Promise.all([
      careerPromise,
      historyPromise,
      seasonsPromise,
    ]);
    career = careerResult;
    raceHistory = history;

    // --- Career Moves: each season (oldest first) whose primary team (teams[0]) differs from the season
    // before; "Independent" means no team. Season granularity only, since team stats have no dates.
    if (career) {
      const chronological = [...career.seasons].sort((a, b) => a.season.number - b.season.number);
      let prevTeamName: string | null = null;
      let prevLogoUrl: string | null = null;
      for (const s of chronological) {
        const primary = s.teams[0] ?? null;
        const currentTeamName = primary?.teamName ?? null;
        const currentLogoUrl = primary?.logoUrl ?? null;
        if (currentTeamName !== prevTeamName) {
          careerMoves.push({
            seasonName: s.season.name,
            from: prevTeamName ?? 'Independent',
            to: currentTeamName ?? 'Independent',
            fromLogoUrl: prevLogoUrl,
            toLogoUrl: currentLogoUrl,
          });
          prevTeamName = currentTeamName;
          prevLogoUrl = currentLogoUrl;
        }
      }
      careerMoves.reverse(); // newest first, matching every other table on this page
    }

    // --- Class Moves: like Career Moves but for class, and the debut season gets no entry, since a debut
    // isn't a class change.
    if (career) {
      const chronological = [...career.seasons].sort((a, b) => a.season.number - b.season.number);
      let prevClassName: string | null = null;
      chronological.forEach((s, i) => {
        if (i === 0) {
          prevClassName = s.className;
          return;
        }
        if (s.className !== prevClassName) {
          classMoves.push({ seasonName: s.season.name, from: prevClassName ?? '—', to: s.className });
          prevClassName = s.className;
        }
      });
      classMoves.reverse(); // newest first, matching every other table on this page
    }

    // --- Related News. A post counts if it tags the driver (0082) or links a round they raced; checking
    // recap contents would recompute every recap (about 8 queries each).
    const news = await newsPromise;
    if (news) {
      const [allPosts, driverLinks, tagLinks] = news;
      const taggedPostIds = new Set(
        driverLinks.filter((l) => l.drivers?.id === driverId).map((l) => l.post_id),
      );
      const racedSubsessionIds = new Set(raceHistory.map((r) => r.subsessionId));
      relatedPosts = allPosts
        .filter(
          (p) =>
            taggedPostIds.has(p.id) ||
            (p.round_subsession_id !== null && racedSubsessionIds.has(p.round_subsession_id)),
        )
        .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
      relatedLogoBySeasonLabel = new Map(
        seasons
          .filter((s) => s.logo_url)
          .map((s) => [s.name, { dark: s.logo_url!, light: s.logo_url_light }]),
      );
      for (const link of tagLinks) {
        if (!link.news_tags) continue;
        if (!relatedTagsByPostId.has(link.post_id)) relatedTagsByPostId.set(link.post_id, []);
        relatedTagsByPostId.get(link.post_id)!.push(link.news_tags);
      }
    }
  } catch (err) {
    console.error('Failed to load driver profile data:', err);
    loadError = err instanceof Error ? err.message : String(err);
  }

  const driverIncidents = await incidentsPromise;
  return {
    notFound,
    privateProfile,
    loadError,
    career,
    raceHistory,
    relatedPosts,
    relatedLogoBySeasonLabel,
    relatedTagsByPostId,
    careerMoves,
    classMoves,
    driverIncidents,
  };
}

/**
 * The driver profile's Awards panel, loaded and cached on its own (drivers/[id]/awards): championships from
 * the driver's career, the computed season awards (computeSeasonAwardsHistory, unchanged, over every
 * season) and the manual awards. Hall of Fame status is read here, so the fragment URL takes no parameters.
 */
export async function loadDriverAwards(supabaseEnv: SupabaseEnv, driverId: string) {
  let notFound = false;
  let privateProfile = false;
  let loadError: string | null = null;
  const awardEntries: AwardEntry[] = [];
  let isHallOfFame = false;
  if (!UUID.test(driverId)) return { notFound: true, privateProfile, loadError, awardEntries, isHallOfFame };
  try {
    // Stage 1: the driver check (with its Hall of Fame flag) alongside the light reads; no awards
    // history, the costly part, for an unknown id.
    const base = loadCareerInputs(supabaseEnv);
    const manualAwardsPromise = getManualAwards(supabaseEnv);
    manualAwardsPromise.catch(() => undefined);
    const driver = await findProfileDriver(supabaseEnv, driverId);
    if (!driver) {
      notFound = true;
      return { notFound, privateProfile, loadError, awardEntries, isHallOfFame };
    }
    // A private profile (BR9.11): no awards history is read.
    if (driver.profile_private) {
      privateProfile = true;
      return { notFound, privateProfile, loadError, awardEntries, isHallOfFame };
    }
    isHallOfFame = driver.is_hall_of_fame === true;
    const { seasons: seasonsPromise, career: careerPromise } = loadCareer(supabaseEnv, driverId, base);
    const [career, seasons, seasonAwardsList, manualAwards] = await Promise.all([
      careerPromise,
      seasonsPromise,
      seasonsPromise.then((seasons) => computeSeasonAwardsHistory(supabaseEnv, seasons)),
      manualAwardsPromise,
    ]);
    awardEntries.push(...championshipAwards(career), ...seasonAwards(seasonAwardsList, driverId));
    for (const ma of manualAwards) {
      if (ma.driver_id !== driverId) continue;
      const season = seasons.find((s: Season) => s.id === ma.season_id);
      awardEntries.push({
        seasonNumber: season?.number ?? -1,
        seasonName: season?.name ?? 'Unknown season',
        label: ma.award_key === 'best_racecraft' ? 'Best Racecraft' : 'Most Improved',
        detail: null,
      });
    }
    awardEntries.sort((a, b) => b.seasonNumber - a.seasonNumber || a.label.localeCompare(b.label));
  } catch (err) {
    console.error('Failed to load driver awards:', err);
    loadError = err instanceof Error ? err.message : String(err);
  }
  return { notFound, privateProfile, loadError, awardEntries, isHallOfFame };
}

/** Class, team and Delta team championships. Not for a season still in progress, per Logan. */
function championshipAwards(career: DriverCareerStats | null): AwardEntry[] {
  const out: AwardEntry[] = [];
  for (const s of career?.seasons ?? []) {
    if (s.season.is_current) continue;
    const base = { seasonNumber: s.season.number, seasonName: s.season.name };
    if (s.classPosition === 1) {
      out.push({ ...base, label: `${s.className} Champion`, detail: null, className: s.className });
    }
    // Team trophies are tinted by the driver's own class that season: a roster can mix classes.
    if (s.teamPosition === 1) {
      out.push({
        ...base,
        label: 'Team Champion',
        detail: s.teams[0]?.teamName ?? null,
        className: s.className,
      });
    }
    if (s.deltaTeamPosition === 1) {
      out.push({
        ...base,
        label: 'Delta Team Champion',
        detail: s.teams[0]?.teamName ?? null,
        className: s.className,
      });
    }
  }
  return out;
}

/** The 12 computed season awards this driver won. */
function seasonAwards(
  seasonAwardsList: Awaited<ReturnType<typeof computeSeasonAwardsHistory>>,
  driverId: string,
): AwardEntry[] {
  const out: AwardEntry[] = [];
  for (const sa of seasonAwardsList) {
    const base = { seasonNumber: sa.season.number, seasonName: sa.season.name };
    const won = (award: { drivers: { id: string }[] } | null | undefined) =>
      award?.drivers.some((d) => d.id === driverId) === true;

    if (won(sa.rookieOfTheSeason)) {
      out.push({
        ...base,
        label: 'Rookie of the Season',
        detail: `${trimNum(sa.rookieOfTheSeason!.value, 1)} pts`,
      });
    }
    if (won(sa.sublimeFinesse)) {
      out.push({
        ...base,
        label: 'Sublime Finesse',
        detail: `${trimNum(sa.sublimeFinesse!.value, 1)} corners/incident`,
      });
    }
    if (won(sa.leader)) {
      out.push({ ...base, label: 'Leader', detail: `${trimNum(sa.leader!.value, 0)} laps led` });
    }
    if (won(sa.ironman)) {
      out.push({ ...base, label: 'Ironman', detail: `${trimNum(sa.ironman!.value, 1)} km` });
    }
    if (won(sa.consistency)) {
      out.push({ ...base, label: 'Consistency', detail: `${trimNum(sa.consistency!.value, 2)} avg finish` });
    }
    if (won(sa.bonusFeature)) {
      out.push({
        ...base,
        label: 'Bonus Feature',
        detail: `${trimNum(sa.bonusFeature!.value, 1)} bonus pts`,
      });
    }
    if (won(sa.nakedAggression)) {
      out.push({
        ...base,
        label: 'Naked Aggression',
        detail: `${signedNum(sa.nakedAggression!.value)} net positions`,
      });
    }
    if (won(sa.speedDemon)) {
      const v = sa.speedDemon!.value;
      out.push({ ...base, label: 'Speed Demon', detail: `${v} fastest lap${v === 1 ? '' : 's'}` });
    }
    if (won(sa.enduranceSpecialist)) {
      out.push({
        ...base,
        label: 'Endurance Specialist',
        detail: `${trimNum(sa.enduranceSpecialist!.value, 1)} pts`,
      });
    }
    if (won(sa.sprintSpecialist)) {
      out.push({
        ...base,
        label: 'Sprint Specialist',
        detail: `${trimNum(sa.sprintSpecialist!.value, 1)} pts`,
      });
    }
    for (const [label, award] of [
      ['Dominator', sa.dominator],
      ['Defender', sa.defender],
    ] as const) {
      for (const e of award?.entries ?? []) {
        if (e.driver.id !== driverId) continue;
        const marginText = `${(award!.value / 10000).toFixed(3)}s`;
        const raceText = `${e.trackName}${e.raceNumber > 1 ? ` (Race ${e.raceNumber})` : ''}`;
        out.push({ ...base, label, detail: `${marginText} — ${raceText}` });
      }
    }
  }
  return out;
}
