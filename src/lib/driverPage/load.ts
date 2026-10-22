import { getNewsPosts, type NewsPost, type SupabaseEnv } from '../db/client';
import { getDriverClasses } from '../db/lookups';
import { getSeasons, type SeasonLogoPair } from '../db/seasons';
import { getStandingsExcludedRoundIds } from '../db/rounds';
import { getManualAwards } from '../db/awards';
import { getAllNewsPostDrivers, getAllNewsPostTags, type NewsTag } from '../db/news';
import { computeDriverCareerStats, type DriverCareerStats } from '../results/careerStats';
import { getDriverRaceHistory, type DriverRaceHistoryRow } from '../results/raceHistory';
import { computeSeasonAwardsHistory } from '../results/awards';
import { getAllIncidents, type IncidentRow } from '../incidents';
import { trimNum, signedNum, type AwardEntry, type CareerMove, type ClassMove } from './helpers';

/**
 * Everything the driver profile fragment fetches. A failure of the main block sets loadError (the page
 * then renders its error state and is not cached); news and incidents fail on their own, leaving
 * their lists empty.
 */
export async function loadDriverPage(supabaseEnv: SupabaseEnv, driverId: string) {
  let loadError: string | null = null;
  let career: DriverCareerStats | null = null;
  let raceHistory: DriverRaceHistoryRow[] = [];

  // Related News: posts that tag this driver or link a round they raced (loaded near the end of the main
  // block).
  let relatedPosts: NewsPost[] = [];
  let relatedLogoBySeasonLabel = new Map<string, SeasonLogoPair>();
  let relatedTagsByPostId = new Map<string, NewsTag[]>();

  const careerMoves: CareerMove[] = [];
  const classMoves: ClassMove[] = [];
  const awardEntries: AwardEntry[] = [];

  try {
    const [classes, seasons, exhibitionRoundIds] = await Promise.all([
      getDriverClasses(supabaseEnv),
      getSeasons(supabaseEnv),
      getStandingsExcludedRoundIds(supabaseEnv),
    ]);

    const [careerStatsAll, history, seasonAwardsList, manualAwards] = await Promise.all([
      computeDriverCareerStats(supabaseEnv, seasons, classes, exhibitionRoundIds),
      getDriverRaceHistory(supabaseEnv, driverId),
      computeSeasonAwardsHistory(supabaseEnv, seasons),
      getManualAwards(supabaseEnv),
    ]);

    career = careerStatsAll.find((c) => c.driver.id === driverId) ?? null;
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

    // --- Awards: championships, team championships, the 12 computed season awards this driver won, and the 2
    // manual awards. Hall of Fame isn't season-scoped and is pinned separately.
    if (career) {
      for (const s of career.seasons) {
        // Not s.season.is_current — no championship of any kind granted for a
        // season still in progress, per Logan (same gate
        // aggregateDriverCareerStats' own championships count uses).
        if (s.classPosition === 1 && !s.season.is_current) {
          awardEntries.push({
            seasonNumber: s.season.number,
            seasonName: s.season.name,
            label: `${s.className} Champion`,
            detail: null,
            className: s.className,
          });
        }
        if (s.teamPosition === 1 && !s.season.is_current) {
          awardEntries.push({
            seasonNumber: s.season.number,
            seasonName: s.season.name,
            label: 'Team Champion',
            detail: s.teams[0]?.teamName ?? null,
            // Tinted by this driver's OWN class that season (there's no
            // single "team class" to key off — a roster can mix classes) —
            // same trophy treatment as the class-championship entry above.
            className: s.className,
          });
        }
        if (s.deltaTeamPosition === 1 && !s.season.is_current) {
          awardEntries.push({
            seasonNumber: s.season.number,
            seasonName: s.season.name,
            label: 'Delta Team Champion',
            detail: s.teams[0]?.teamName ?? null,
            className: s.className,
          });
        }
      }
    }

    for (const sa of seasonAwardsList) {
      const seasonNumber = sa.season.number;
      const seasonName = sa.season.name;

      if (sa.rookieOfTheSeason?.drivers.some((d) => d.id === driverId)) {
        awardEntries.push({
          seasonNumber,
          seasonName,
          label: 'Rookie of the Season',
          detail: `${trimNum(sa.rookieOfTheSeason.value, 1)} pts`,
        });
      }
      if (sa.sublimeFinesse?.drivers.some((d) => d.id === driverId)) {
        awardEntries.push({
          seasonNumber,
          seasonName,
          label: 'Sublime Finesse',
          detail: `${trimNum(sa.sublimeFinesse.value, 1)} corners/incident`,
        });
      }
      if (sa.leader?.drivers.some((d) => d.id === driverId)) {
        awardEntries.push({
          seasonNumber,
          seasonName,
          label: 'Leader',
          detail: `${trimNum(sa.leader.value, 0)} laps led`,
        });
      }
      if (sa.ironman?.drivers.some((d) => d.id === driverId)) {
        awardEntries.push({
          seasonNumber,
          seasonName,
          label: 'Ironman',
          detail: `${trimNum(sa.ironman.value, 1)} km`,
        });
      }
      if (sa.consistency?.drivers.some((d) => d.id === driverId)) {
        awardEntries.push({
          seasonNumber,
          seasonName,
          label: 'Consistency',
          detail: `${trimNum(sa.consistency.value, 2)} avg finish`,
        });
      }
      if (sa.bonusFeature?.drivers.some((d) => d.id === driverId)) {
        awardEntries.push({
          seasonNumber,
          seasonName,
          label: 'Bonus Feature',
          detail: `${trimNum(sa.bonusFeature.value, 1)} bonus pts`,
        });
      }
      if (sa.nakedAggression?.drivers.some((d) => d.id === driverId)) {
        awardEntries.push({
          seasonNumber,
          seasonName,
          label: 'Naked Aggression',
          detail: `${signedNum(sa.nakedAggression.value)} net positions`,
        });
      }
      if (sa.speedDemon?.drivers.some((d) => d.id === driverId)) {
        const v = sa.speedDemon.value;
        awardEntries.push({
          seasonNumber,
          seasonName,
          label: 'Speed Demon',
          detail: `${v} fastest lap${v === 1 ? '' : 's'}`,
        });
      }
      if (sa.enduranceSpecialist?.drivers.some((d) => d.id === driverId)) {
        awardEntries.push({
          seasonNumber,
          seasonName,
          label: 'Endurance Specialist',
          detail: `${trimNum(sa.enduranceSpecialist.value, 1)} pts`,
        });
      }
      if (sa.sprintSpecialist?.drivers.some((d) => d.id === driverId)) {
        awardEntries.push({
          seasonNumber,
          seasonName,
          label: 'Sprint Specialist',
          detail: `${trimNum(sa.sprintSpecialist.value, 1)} pts`,
        });
      }
      for (const e of sa.dominator?.entries ?? []) {
        if (e.driver.id === driverId) {
          const marginText = `${(sa.dominator!.value / 10000).toFixed(3)}s`;
          const raceText = `${e.trackName}${e.raceNumber > 1 ? ` (Race ${e.raceNumber})` : ''}`;
          awardEntries.push({
            seasonNumber,
            seasonName,
            label: 'Dominator',
            detail: `${marginText} — ${raceText}`,
          });
        }
      }
      for (const e of sa.defender?.entries ?? []) {
        if (e.driver.id === driverId) {
          const marginText = `${(sa.defender!.value / 10000).toFixed(3)}s`;
          const raceText = `${e.trackName}${e.raceNumber > 1 ? ` (Race ${e.raceNumber})` : ''}`;
          awardEntries.push({
            seasonNumber,
            seasonName,
            label: 'Defender',
            detail: `${marginText} — ${raceText}`,
          });
        }
      }
    }

    for (const ma of manualAwards) {
      if (ma.driver_id !== driverId) continue;
      const season = seasons.find((s) => s.id === ma.season_id);
      awardEntries.push({
        seasonNumber: season?.number ?? -1,
        seasonName: season?.name ?? 'Unknown season',
        label: ma.award_key === 'best_racecraft' ? 'Best Racecraft' : 'Most Improved',
        detail: null,
      });
    }

    awardEntries.sort((a, b) => b.seasonNumber - a.seasonNumber || a.label.localeCompare(b.label));

    // --- Related News, in its own try/catch so news can't break the rest of the page. A post counts if it
    // tags the driver (0082) or links a round they raced; checking recap contents would recompute every recap
    // (about 8 queries each).
    try {
      const [allPosts, driverLinks, tagLinks] = await Promise.all([
        getNewsPosts(supabaseEnv),
        getAllNewsPostDrivers(supabaseEnv),
        getAllNewsPostTags(supabaseEnv),
      ]);
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
    } catch (err) {
      console.error('Failed to load related news for driver profile:', err);
    }
  } catch (err) {
    console.error('Failed to load driver profile data:', err);
    loadError = err instanceof Error ? err.message : String(err);
  }

  // --- Incidents the driver is penalised in or involved in, in their own try/catch. Reuses
  // getAllIncidents()' byDriver rollup (src/lib/incidents.ts), appeal-aware, rather than rebuilding it.
  let driverIncidents: IncidentRow[] = [];
  try {
    const incidentsData = await getAllIncidents(supabaseEnv);
    driverIncidents = incidentsData.byDriver.find((d) => d.driver.id === driverId)?.incidents ?? [];
  } catch (err) {
    console.error('Failed to load incident history for driver profile:', err);
  }
  return {
    loadError,
    career,
    raceHistory,
    relatedPosts,
    relatedLogoBySeasonLabel,
    relatedTagsByPostId,
    careerMoves,
    classMoves,
    awardEntries,
    driverIncidents,
  };
}
