/**
 * Close Appeal and the appeal cards on the Reported Incidents screen (appeals unit U1): the Close Appeal
 * form's prefill and checks (BR3.1), and which buttons and outcome lines a card shows (BR1.2, BR1.3, BR5.1).
 * Pure, so the page, the actions and the tests share one rule; the database makes the final call on every
 * write (BR3.2, BR3.5).
 */

import {
  APPEAL_COMMENT_MAX_LENGTH,
  type CloseAppealInput,
  type IncidentAppeal,
} from './incidentAppeals';
import {
  effectiveIsWarning,
  effectivePenaltyPoints,
  effectivePointsPenalty,
  effectiveTimePenaltySeconds,
  type PenaltyLike,
  type WarningLike,
} from './penalties/effective';

/** The largest value an integer column holds; anything above it would fail in the database. */
const MAX_INT = 2_147_483_647;

/** What the Close Appeal popup opens with: the penalty's effective values, a missing time shown as 0 (BR3.1). */
export function closeAppealPrefill(p: PenaltyLike & WarningLike): Omit<CloseAppealInput, 'comment'> {
  return {
    timePenaltySeconds: effectiveTimePenaltySeconds(p) ?? 0,
    pointsPenalty: effectivePointsPenalty(p),
    penaltyPoints: effectivePenaltyPoints(p),
    isWarning: effectiveIsWarning(p),
  };
}

/** Characters as the database counts them (char_length), so an emoji counts once. */
export function commentLength(text: string): number {
  return [...text].length;
}

export type CloseAppealParse =
  | { ok: true; appealId: string; input: CloseAppealInput }
  | { ok: false; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The appeal id from a posted form, or null when it isn't a uuid. */
export function parseAppealId(form: FormData): string | null {
  const id = String(form.get('appeal_id') ?? '').trim();
  return UUID.test(id) ? id : null;
}

/**
 * A steward comment as posted: trimmed, 1 to 4,000 characters (BR2.2). Returns the text to save, or a message.
 */
export function parseAppealCommentBody(form: FormData): { ok: true; body: string } | { ok: false; message: string } {
  const body = String(form.get('body') ?? '').trim();
  if (body === '') return { ok: false, message: 'Write a comment before saving.' };
  if (commentLength(body) > APPEAL_COMMENT_MAX_LENGTH)
    return { ok: false, message: `A comment can be at most ${APPEAL_COMMENT_MAX_LENGTH} characters.` };
  return { ok: true, body };
}

/**
 * The Close Appeal form, checked as the database checks it (BR3.1): a time of 0 or more with at most 3
 * decimals, whole points and licence points of 0 or more, a warning tick, and a comment of 1 to 4,000
 * characters after trimming.
 */
export function parseCloseAppealForm(form: FormData): CloseAppealParse {
  const appealId = parseAppealId(form);
  if (!appealId) return { ok: false, message: 'That appeal could not be found.' };

  const time = String(form.get('time_penalty_seconds') ?? '').trim();
  if (!/^\d+(\.\d{1,3})?$/.test(time) || !Number.isFinite(Number(time)))
    return { ok: false, message: 'The time penalty must be 0 or more seconds, with at most 3 decimals.' };

  const whole = (name: string): number | null => {
    const raw = String(form.get(name) ?? '').trim();
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return n <= MAX_INT ? n : null;
  };
  const pointsPenalty = whole('points_penalty');
  if (pointsPenalty === null) return { ok: false, message: 'The points penalty must be a whole number of 0 or more.' };
  const penaltyPoints = whole('penalty_points');
  if (penaltyPoints === null) return { ok: false, message: 'Penalty points must be a whole number of 0 or more.' };

  const comment = String(form.get('comment') ?? '').trim();
  if (comment === '') return { ok: false, message: 'Write a comment explaining the decision.' };
  if (commentLength(comment) > APPEAL_COMMENT_MAX_LENGTH)
    return { ok: false, message: `The comment can be at most ${APPEAL_COMMENT_MAX_LENGTH} characters.` };

  const warning = String(form.get('is_warning') ?? '');
  return {
    ok: true,
    appealId,
    input: {
      timePenaltySeconds: Number(time),
      pointsPenalty,
      penaltyPoints,
      isWarning: warning === 'on' || warning === 'true',
      comment,
    },
  };
}

/** The decided values one close recorded, one line each, for the closed card (BR5.1). */
export function decisionLines(d: {
  timePenaltySeconds: number;
  pointsPenalty: number;
  penaltyPoints: number;
  isWarning: boolean;
}): string[] {
  return [
    `Time penalty: ${d.timePenaltySeconds} s`,
    `Points penalty: ${d.pointsPenalty}`,
    `Penalty points: ${d.penaltyPoints}`,
    `Warning: ${d.isWarning ? 'Yes' : 'No'}`,
  ];
}

export interface AppealCardView {
  badge: 'Open' | 'Dismissed' | 'Closed';
  viewDecision: boolean;
  dismiss: boolean;
  closeAppeal: boolean;
  /** The comment button's label, or null when it isn't offered. */
  commentLabel: 'Add Comment' | 'Edit Comment' | null;
  reopen: boolean;
  /** The close record; null for open and dismissed appeals and for appeals reviewed before Close Appeal. */
  outcome: { lines: string[]; comment: string; closedBy: string; closedAt: string } | null;
}

/**
 * Which buttons and outcome lines an appeal card shows. Open: View Decision, Dismiss, Close Appeal and
 * Add/Edit Comment (BR1.2); dismissed: Reopen (BR1.3); closed: nothing, plus the close record when there is
 * one (BR5.1). An involved steward gets View Decision only, since the database refuses the rest (BR2.1, BR3.7).
 */
export function appealCardView(
  appeal: Pick<
    IncidentAppeal,
    | 'status'
    | 'closed_at'
    | 'closed_by'
    | 'close_comment'
    | 'decided_time_penalty_seconds'
    | 'decided_points_penalty'
    | 'decided_penalty_points'
    | 'decided_is_warning'
    | 'closer'
  >,
  viewerHasComment: boolean,
  viewerInvolved = false,
): AppealCardView {
  const open = appeal.status === 'open';
  const canAct = !viewerInvolved;
  const view: AppealCardView = {
    badge: open ? 'Open' : appeal.status === 'dismissed' ? 'Dismissed' : 'Closed',
    viewDecision: open,
    dismiss: open && canAct,
    closeAppeal: open && canAct,
    commentLabel: open && canAct ? (viewerHasComment ? 'Edit Comment' : 'Add Comment') : null,
    reopen: appeal.status === 'dismissed' && canAct,
    outcome: null,
  };
  if (appeal.status === 'reviewed' && appeal.closed_at) {
    view.outcome = {
      lines: decisionLines({
        timePenaltySeconds: Number(appeal.decided_time_penalty_seconds ?? 0),
        pointsPenalty: appeal.decided_points_penalty ?? 0,
        penaltyPoints: appeal.decided_penalty_points ?? 0,
        isWarning: appeal.decided_is_warning ?? false,
      }),
      comment: appeal.close_comment ?? '',
      closedBy: appeal.closed_by
        ? appeal.closer?.display_name?.trim() || 'Unknown steward'
        : 'a former steward',
      closedAt: appeal.closed_at,
    };
  }
  return view;
}
