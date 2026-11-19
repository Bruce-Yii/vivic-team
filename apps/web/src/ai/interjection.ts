import { looksLikeCommand } from "./turnTaking";
import type { TaskProjection } from "./taskProjection";
import type { InterruptedSpeechContext, TurnIntent } from "./turnTaking";

/**
 * Turn policy for a user utterance that lands while a Hosted Task is in flight.
 *
 * The full-duplex coordinator is the only place that decides "pause / stop /
 * supersede / queue" for a final transcript, and it must make that decision
 * from the Host's real task projection instead of a local guess:
 *
 * - a read-only task (`canSafelySupersede`) may be cancelled once and replaced
 *   by the new command,
 * - a mutating (write) task is never cancelled implicitly; a follow-up phrased
 *   as a constraint is queued for the next planning turn,
 * - an explicit "取消" is still honoured, but only for the one captured task.
 *
 * The policy is pure so the acceptance tests can assert the exact call counts
 * (`cancelTask` at most once, `dispatch` at most once) without a browser, and
 * `applyInterjection` is the single effect executor the coordinator uses.
 */
/** Longer than this while the assistant speaks is ambient speech, not a barge-in. */
export const SHORT_INTERRUPTION_CHARS = 12;
/** A command-shaped utterance may be longer, but not paragraph-length. */
export const COMMAND_MAX_CHARS = 40;

export interface InterjectionContext {
  /** Deterministic intent for the committed transcript. */
  intent: TurnIntent;
  transcript: string;
  /** True while assistant TTS is loading/playing. */
  speechActive: boolean;
  /** Read-only projection of the Host task captured when this turn began. */
  task: TaskProjection | null;
  /** Task id captured when this speech segment began; null when no task was in flight. */
  taskId: string | null;
}

export interface InterjectionDecision {
  intent: TurnIntent;
  /** Lower the ducked playback volume (the transcript was committed). */
  unduck: boolean;
  /** Build and publish truncated playback context for the next turn. */
  captureInterrupted: boolean;
  /** End a paused playback instead of resuming it (a real barge-in). */
  confirmBargeIn: boolean;
  /** The one task to cancel, or null. Never more than one id. */
  cancelTaskId: string | null;
  /** Queue the utterance as a working constraint for the next planning turn. */
  queueConstraint: boolean;
  /** True when this utterance becomes exactly one new command turn. */
  dispatch: boolean;
  /** `cancelRunning` handed to the command handler; false protects in-flight writes. */
  cancelRunning: boolean;
  /** Resume paused playback ("继续"). */
  resumePlayback: boolean;
}

const base = (intent: TurnIntent): InterjectionDecision => ({
  intent,
  unduck: true,
  captureInterrupted: false,
  confirmBargeIn: false,
  cancelTaskId: null,
  queueConstraint: false,
  dispatch: false,
  cancelRunning: false,
  resumePlayback: false,
});

/**
 * Map one committed transcript onto the single safe action set. The branches
 * mirror the historical coordinator branches one-for-one; the difference is
 * that the decision is now data, so it can be asserted.
 */
export function decideInterjection(context: InterjectionContext): InterjectionDecision {
  const { intent, transcript, speechActive, task, taskId } = context;
  const decision = base(intent);
  // An explicit cancel is allowed even for a write: the user asked for it. A
  // terminal task has nothing left to abort.
  const cancelable = taskId !== null && (task === null || task.isTerminal !== true) ? taskId : null;
  // Only a read-only in-flight task may be replaced by a new turn. A write task
  // keeps running: its result must still be reported, never silently dropped.
  const canSafelySupersede = task?.canSafelySupersede === true;
  const supersedeTarget = canSafelySupersede ? taskId : null;
  const active = task?.isActive === true;

  if (!speechActive) {
    // Tool-execution window: no playback to interrupt, only task policy applies.
    if (intent === "backchannel" || intent === "irrelevant" || intent === "stop") return decision;
    if (intent === "continue") return { ...decision, resumePlayback: true };
    if (intent === "cancel_task") return { ...decision, cancelTaskId: cancelable };
    if (intent === "new_constraint" && active) return { ...decision, queueConstraint: true };
    // new_topic, a constraint with no active task, or an unclassified command:
    // exactly one new turn supersedes only read-only work.
    return { ...decision, dispatch: true, cancelRunning: canSafelySupersede, cancelTaskId: supersedeTarget };
  }

  // The assistant is speaking: stop/cancel barge in, a constraint pauses, and a
  // new topic supersedes only read-only work after confirming the barge-in.
  const brief = [...transcript].length <= SHORT_INTERRUPTION_CHARS;
  if (intent === "stop" && brief) return { ...decision, captureInterrupted: true };
  if (intent === "cancel_task" && brief) return { ...decision, captureInterrupted: true, cancelTaskId: cancelable };
  if (intent === "new_constraint") {
    if (active) return { ...decision, captureInterrupted: true, queueConstraint: true };
    return { ...decision, captureInterrupted: true, confirmBargeIn: true, dispatch: true };
  }
  // Measured on 20 real human utterances replayed during playback: treating any
  // two-character `unknown` transcript as a barge-in stopped the assistant on
  // 88% of ambient speech (TV, other people, feedback words). An unclassified
  // transcript is therefore NOT a barge-in; only explicit short interruptions are.
  // Long sentences that merely contain a keyword ("…取消限购…") are ambient speech.
  const length = [...transcript].length;
  // A brand-new instruction ("帮我看看明天的日程") is a real turn even when it has
  // no interrupt keyword; ambient speech is filtered by the command phrasing and
  // the self-echo guard upstream.
  const commandLikeUnknown = intent === "unknown" && looksLikeCommand(transcript) && length <= COMMAND_MAX_CHARS;
  if ((intent === "new_topic" && length <= SHORT_INTERRUPTION_CHARS) || commandLikeUnknown) {
    return { ...decision, captureInterrupted: true, confirmBargeIn: true, dispatch: true,
      cancelRunning: canSafelySupersede, cancelTaskId: supersedeTarget };
  }
  return decision;
  // backchannel / continue / irrelevant never interrupt active playback.
  return decision;
}

export interface InterjectionEffects {
  transcript: string;
  turnId: number;
  /** Built by the caller before TTS state is torn down; null when nothing was speaking. */
  interrupted: InterruptedSpeechContext | null;
  unduck(): void;
  confirmBargeIn(): void;
  cancelTask(taskId: string): void;
  dispatch(text: string, options: { cancelRunning: boolean; interruptedContext: InterruptedSpeechContext | null | undefined }): void;
  queueConstraint(text: string, turnId: number): void;
  /** Current queued constraints after `queueConstraint` ran, for the overlay snapshot. */
  pendingConstraints(): readonly string[];
  publishInterrupted(context: InterruptedSpeechContext | null): void;
  publishPendingConstraints(constraints: readonly string[]): void;
  resumePlayback(): void;
}

export interface InterjectionOutcome {
  dispatchCount: number;
  cancelCount: number;
  queuedConstraint: boolean;
}

/**
 * Execute one decision. Every effect is called at most once; the returned
 * counters are the acceptance evidence (one supersede = one cancel + one
 * dispatch, never a duplicate execution).
 */
export function applyInterjection(decision: InterjectionDecision, effects: InterjectionEffects): InterjectionOutcome {
  const outcome: InterjectionOutcome = { dispatchCount: 0, cancelCount: 0, queuedConstraint: false };
  if (decision.resumePlayback) {
    effects.resumePlayback();
    effects.unduck();
    return outcome;
  }
  if (decision.captureInterrupted) effects.publishInterrupted(effects.interrupted);
  if (decision.confirmBargeIn) effects.confirmBargeIn();
  if (decision.unduck) effects.unduck();
  if (decision.queueConstraint) {
    effects.queueConstraint(effects.transcript, effects.turnId);
    effects.publishPendingConstraints(effects.pendingConstraints());
    outcome.queuedConstraint = true;
  }
  if (decision.cancelTaskId !== null) {
    effects.cancelTask(decision.cancelTaskId);
    outcome.cancelCount += 1;
  }
  if (decision.dispatch) {
    effects.dispatch(effects.transcript, {
      cancelRunning: decision.cancelRunning,
      // Only a turn that actually interrupted playback carries a context; a plain
      // in-flight command must not clear the previous one.
      interruptedContext: decision.captureInterrupted ? effects.interrupted : undefined,
    });
    outcome.dispatchCount += 1;
  }
  return outcome;
}
