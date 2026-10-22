import { createPenalty, updatePenalty, type PenaltyInput } from '../db/penalties';
import { recomputeDriverSeasonPP, strOrNullField, numOrNullField, numOrZeroField } from '../penaltyActions';
import { setIncidentReportStatus } from '../incidentReports';
import { logActivity } from '../activityLog';
import { REPORTS_ANCHOR } from './anchors';
import type { IncidentActionContext, IncidentActionRedirect } from './context';

/** `add-incident` and `update-incident` (admin only). */
export async function handleSaveIncident(
  ctx: IncidentActionContext,
  form: FormData,
  intent: string,
): Promise<IncidentActionRedirect> {
  const { supabaseEnv, accessToken, actor, roundLabel, shellPath, subsessionId } = ctx;
  // The Session value encodes kind and race: "race:2", "qualifying:0", "practice:0". The 0 sentinel (0056)
  // never collides with a real race (1-5); a qualifying/practice penalty scores on race 1 (scoringRaceNumber
  // in src/lib/penalties/effective.ts; score_round does the same).
  const [sessionTypeRaw, raceNumberRaw] = String(form.get('session') ?? '').split(':');
  const sessionType: 'race' | 'qualifying' | 'practice' =
    sessionTypeRaw === 'qualifying' || sessionTypeRaw === 'practice' ? sessionTypeRaw : 'race';
  const raceNumber = sessionType === 'race' ? Number(raceNumberRaw) : 0;
  const isRaceSession = sessionType === 'race';
  // Cars at fault (src/scripts/faultCards.ts): one penalty row per car with its own "<field>:<driver id>"
  // values; the session, number, lap, description and involved cars are shared. Nothing ticked is a Racing
  // Incident: one driverless row with no penalty (0020), enforced here. An edit updates one row, so only the
  // first car counts.
  const faultDriverIds = [...new Set(form.getAll('fault_driver_ids').map(String).filter(Boolean))];
  const penalizedDriverIds = intent === 'update-incident' ? faultDriverIds.slice(0, 1) : faultDriverIds;
  const involvedDriverIds = form.getAll('involved_driver_ids').map(String);

  const shared = {
    subsession_id: subsessionId,
    race_number: raceNumber,
    session_type: sessionType,
    incident_number: strOrNullField(form, 'incident_number'),
    lap: numOrNullField(form, 'lap'),
    description: strOrNullField(form, 'description'),
    // Appeals are edit-only in the dialog (they're about one car's existing
    // penalty), so these are blank on every Add.
    is_appealed: form.get('is_appealed') === 'on',
    appeal_result: strOrNullField(form, 'appeal_result'),
    appeal_time_penalty_seconds: numOrNullField(form, 'appeal_time_penalty_seconds'),
    appeal_points_penalty: numOrZeroField(form, 'appeal_points_penalty'),
    appeal_penalty_points: numOrZeroField(form, 'appeal_penalty_points'),
  };

  // One dropdown per car sets PP and the warning flag: "warning" is stored as 0 PP (two warnings escalate to
  // +1 PP; 0059), blank is 0, and 1-7 is a PP award. Qualifying/practice penalties apply to race 1 (Logan).
  function penaltyFor(driverId: string | null): { data: PenaltyInput; offenseIds: string[] } {
    if (!driverId) {
      return {
        data: { ...shared, driver_id: null, time_penalty_seconds: null, points_penalty: 0, penalty_points: 0, is_warning: false },
        offenseIds: [],
      };
    }
    const ppChoice = String(form.get(`penalty_points_choice:${driverId}`) ?? '');
    return {
      data: {
        ...shared,
        driver_id: driverId,
        time_penalty_seconds: numOrNullField(form, `time_penalty_seconds:${driverId}`),
        points_penalty: numOrZeroField(form, `points_penalty:${driverId}`),
        penalty_points: ppChoice === 'warning' ? 0 : Number(ppChoice) || 0,
        is_warning: ppChoice === 'warning',
      },
      offenseIds: form.getAll(`offense_ids:${driverId}`).map(String),
    };
  }

  try {
    const savedPenaltyIds: string[] = [];
    if (intent === 'add-incident' && Number.isFinite(raceNumber)) {
      for (const driverId of penalizedDriverIds.length > 0 ? penalizedDriverIds : [null]) {
        const { data, offenseIds } = penaltyFor(driverId);
        const created = await createPenalty(supabaseEnv, accessToken, data, offenseIds, involvedDriverIds);
        if (created?.id) savedPenaltyIds.push(created.id);
      }
    } else if (intent === 'update-incident') {
      const penaltyId = String(form.get('penalty_id') ?? '');
      if (penaltyId) {
        const { data, offenseIds } = penaltyFor(penalizedDriverIds[0] ?? null);
        await updatePenalty(supabaseEnv, accessToken, penaltyId, data, offenseIds, involvedDriverIds);
        savedPenaltyIds.push(penaltyId);
      }
    }
    // Re-tally every car whose season PP may have changed — on an edit that
    // moved the penalty to a different car, the car it was taken off too.
    const originalDriverId = intent === 'update-incident' ? String(form.get('original_driver_id') ?? '') : '';
    for (const driverId of new Set([...penalizedDriverIds, originalDriverId].filter(Boolean))) {
      await recomputeDriverSeasonPP(supabaseEnv, accessToken, driverId);
    }
    // Logged from a driver's incident report ("Log incident" in the
    // Reported Incidents panel) — mark that report as handled.
    const fromReportId = String(form.get('from_report_id') ?? '');
    if (intent === 'add-incident' && fromReportId) await setIncidentReportStatus(supabaseEnv, accessToken, fromReportId, 'logged');
    const sessionLabel = isRaceSession ? `Race ${raceNumber}` : sessionType === 'qualifying' ? 'Qualifying' : 'Practice';
    await logActivity(supabaseEnv, accessToken, actor, {
      action: intent === 'add-incident' ? 'add' : 'edit',
      entity_type: 'incident',
      entity_label: `${roundLabel} — ${sessionLabel}${shared.incident_number ? ` #${shared.incident_number}` : ''}${savedPenaltyIds.length > 1 ? ` (${savedPenaltyIds.length} cars at fault)` : ''}`,
      entity_id: savedPenaltyIds[0] ?? null,
    });
  } catch (err) {
    console.error('Failed to save incident:', err);
  }
  // Logged from the Reported Incidents panel → back to it, like Dismiss/Reopen below.
  const fromReport = intent === 'add-incident' && Boolean(form.get('from_report_id'));
  return ctx.redirect(`${shellPath}${ctx.url.search}${fromReport ? `#${REPORTS_ANCHOR}` : ''}`);
}
