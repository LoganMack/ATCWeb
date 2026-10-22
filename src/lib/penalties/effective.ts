/**
 * Appeals: once `is_appealed` is set, the appeal_* values replace the originals wherever time, points or PP
 * are read (the effective* helpers); the originals stay as the record.
 */

// --- Appeals: effective-value helpers. Read penalty time/points/PP only through these. ---

export interface PenaltyLike {
  time_penalty_seconds: number | null;
  points_penalty: number;
  penalty_points: number;
  is_appealed: boolean;
  appeal_time_penalty_seconds: number | null;
  appeal_points_penalty: number;
  appeal_penalty_points: number;
}

/** The time penalty actually in effect — the appeal's corrected value once appealed, otherwise the original. */
export function effectiveTimePenaltySeconds(p: PenaltyLike): number | null {
  return p.is_appealed ? p.appeal_time_penalty_seconds : p.time_penalty_seconds;
}

/** The flat championship-points deduction actually in effect. */
export function effectivePointsPenalty(p: PenaltyLike): number {
  return p.is_appealed ? p.appeal_points_penalty : p.points_penalty;
}

/** The PP award actually in effect. */
export function effectivePenaltyPoints(p: PenaltyLike): number {
  return p.is_appealed ? p.appeal_penalty_points : p.penalty_points;
}

/**
 * The penalty tag next to a driver's name: "XPP" (summed effective PP), else "Warning", else "Penalty", or
 * "Racing Incident" for an entry with no effect at all (Logan). Qualifying rows use it too, since a
 * qualifying penalty scores on race 1 but must still show there.
 * ResultsTable.astro keeps its own copy (`penaltyTagLabel`) because sharing this function broke `astro check`
 * for that file; change both together.
 */
export function sharedPenaltyTagLabel(rowPenalties: (PenaltyLike & { is_warning: boolean })[]): string {
  if (rowPenalties.length === 0) return '';
  const totalPP = rowPenalties.reduce((sum, p) => sum + effectivePenaltyPoints(p), 0);
  if (totalPP > 0) return `${totalPP}PP`;
  if (rowPenalties.some((p) => p.is_warning)) return 'Warning';
  const hasTimeOrPointsEffect = rowPenalties.some(
    (p) => effectiveTimePenaltySeconds(p) !== 0 || effectivePointsPenalty(p) !== 0,
  );
  return hasTimeOrPointsEffect ? 'Penalty' : 'Racing Incident';
}

/** Whether a sharedPenaltyTagLabel() result (or ResultsTable.astro's own identical private penaltyTagLabel's result) should render with the "real penalty" gold badge styling (PP/Warning/Penalty) vs. the muted "logged but no effect" styling — true for everything except the empty string (no tag at all) and a bare "Racing Incident" with no logged effect. */
export function isRealPenaltyTag(tagLabel: string): boolean {
  return tagLabel !== '' && tagLabel !== 'Racing Incident';
}

/**
 * The race a penalty applies to. Qualifying and practice incidents are stored
 * with race_number 0 so the Incident Report can group them in their own
 * sections, but their penalty always applies to Race 1, as if it had been
 * logged there. The database's scoring does the same (score_round); the
 * pages use this to key penalties by race for display.
 */
export function scoringRaceNumber(p: {
  session_type: 'race' | 'qualifying' | 'practice';
  race_number: number;
}): number {
  return p.session_type === 'race' ? p.race_number : 1;
}
