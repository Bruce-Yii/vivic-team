import { getSpeechSnapshot, pauseSpeech, resumeSpeech, recordBargeInCandidate, confirmBargeIn, type SpeechSnapshot } from "./speech";
import type { TaskMutationClass } from "./taskProjection";
import { setVadCandidateHandler, startVad, stopVad } from "./vad";

export type TurnIntent = "backchannel" | "stop" | "new_constraint" | "new_topic" | "cancel_task" | "continue" | "irrelevant" | "unknown";

export interface TurnTakingState {
  aiSpeaking: boolean;
  userSpeaking: boolean;
  pausedAtMs: number | null;
  interruptedAtMs: number | null;
  lastIntent: TurnIntent | null;
  taskRunning: boolean;
}

/** Captures what the user actually heard before TTS was interrupted. */
export interface InterruptedSpeechContext {
  interrupted: true;
  reason: "voice" | "ui";
  requestId: string | null;
  fullText: string;
  spokenText: string;
  truncated: boolean;
  playedMs: number | null;
}

export type TaskCancellationPolicy =
  | "abort_immediately"
  | "report_result_no_silent_drop"
  | "require_confirmation";

export interface WorkingContextConstraint {
  text: string;
  turnId: number;
  at: number;
}

const MAX_WORKING_CONSTRAINTS = 8;
let workingConstraints: WorkingContextConstraint[] = [];

export const appendWorkingConstraint = (
  text: string,
  turnId: number,
  now = Date.now(),
): WorkingContextConstraint | null => {
  const cleaned = text.trim();
  if (!cleaned) return null;
  const entry: WorkingContextConstraint = { text: cleaned, turnId, at: now };
  workingConstraints = [...workingConstraints, entry].slice(-MAX_WORKING_CONSTRAINTS);
  return entry;
};

export const getWorkingConstraints = (): readonly WorkingContextConstraint[] => workingConstraints;

export const consumeWorkingConstraints = (): WorkingContextConstraint[] => {
  const items = workingConstraints;
  workingConstraints = [];
  return items;
};

export const clearWorkingConstraints = (): void => {
  workingConstraints = [];
};

/**
 * Aligns interrupted TTS playback with downstream conversation context so the
 * next turn never assumes the user heard unspoken text after barge-in.
 */
export const buildInterruptedSpeechContext = (
  snapshot: Pick<SpeechSnapshot, "status" | "requestId" | "text" | "wordRange" | "playbackLedger">,
  reason: "voice" | "ui" = "voice",
): InterruptedSpeechContext | null => {
  const fullText = snapshot.text?.trim() ?? "";
  if (!fullText) return null;
  if (snapshot.status !== "playing" && snapshot.status !== "loading" && snapshot.status !== "paused") {
    return null;
  }
  const playedMs = snapshot.playbackLedger?.playedMs ?? null;
  const wordEnd = snapshot.wordRange?.end;
  if (typeof wordEnd === "number" && wordEnd > 0 && wordEnd <= fullText.length) {
    return {
      interrupted: true,
      reason,
      requestId: snapshot.requestId,
      fullText,
      spokenText: fullText.slice(0, wordEnd),
      truncated: wordEnd < fullText.length,
      playedMs,
    };
  }
  if (snapshot.status === "loading" || playedMs === null || playedMs <= 0) {
    return {
      interrupted: true,
      reason,
      requestId: snapshot.requestId,
      fullText,
      spokenText: "",
      truncated: true,
      playedMs,
    };
  }
  return {
    interrupted: true,
    reason,
    requestId: snapshot.requestId,
    fullText,
    spokenText: "",
    truncated: snapshot.playbackLedger?.completed !== true,
    playedMs,
  };
};

/**
 * Enforces the safe cancellation boundary between read-only queries and
 * mutating/side-effecting host operations.
 */
export const classifyTaskCancellationSafety = (
  mutationClass: TaskMutationClass,
  alreadyDispatched: boolean,
): TaskCancellationPolicy => {
  if (mutationClass === "read_only") return "abort_immediately";
  if (mutationClass === "mutating") {
    return alreadyDispatched ? "report_result_no_silent_drop" : "abort_immediately";
  }
  return alreadyDispatched ? "report_result_no_silent_drop" : "require_confirmation";
};

let state: TurnTakingState = {
  aiSpeaking: false,
  userSpeaking: false,
  pausedAtMs: null,
  interruptedAtMs: null,
  lastIntent: null,
  taskRunning: false,
};

const listeners = new Set<() => void>();
const update = (patch: Partial<TurnTakingState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export const getTurnTakingState = (): TurnTakingState => state;
export const subscribeTurnTaking = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Classify a transcript into a turn intent via deterministic rules. */
export const classifyIntent = (transcript: string): TurnIntent => {
  const text = transcript.trim().toLowerCase();
  if (!text) return "irrelevant";

  if (/^(停|停止|别说了|闭嘴|安静|shut up|stop|quiet|enough)/i.test(text)) return "stop";
  if (/取消|cancel|abort|discard/i.test(text)) return "cancel_task";
  if (/继续|接着说|接着讲|go on|continue|resume/i.test(text)) return "continue";
  if (/换个话题|说点别的|不说这个|换个说法|new topic|change subject|different topic/i.test(text)) return "new_topic";
  if (/但是|不过|还有|另外|再加|再加一个|还有就是|而且|but |also |additionally |also need/i.test(text)) return "new_constraint";
  if (/^(嗯|好|对|是的|明白|了解|ok|okay|yes|yeah|uh huh|right|sure|got it)$/i.test(text)) return "backchannel";
  if (text.length <= 4 && /^(嗯|好|对|ok|yes|yeah)$/i.test(text)) return "backchannel";

  return "unknown";
};

/** Handle a VAD candidate signal. VAD only produces candidate signals (speech
 * detected). The actual intent is determined from the ASR transcript, not from
 * audio level. This function records the candidate but does NOT auto-act. */
export const handleVadCandidate = (candidate: { level: number; threshold: number; timestamp: number }): void => {
  void candidate;
  update({ userSpeaking: true });
};

/** Handle a completed user transcript during AI playback. Classifies intent
 * from the transcript text and acts accordingly. This is the real turn-taking
 * decision point. */
export const handleUserTranscript = (transcript: string): TurnIntent => {
  const intent = classifyIntent(transcript);
  state.lastIntent = intent;

  if (intent === "stop" || intent === "cancel_task") {
    const result = recordBargeInCandidate();
    if (result) {
      state.interruptedAtMs = result.interruptedAtMs;
      confirmBargeIn();
      update({ aiSpeaking: false, userSpeaking: true, interruptedAtMs: result.interruptedAtMs });
    }
  } else if (intent === "new_constraint" || intent === "new_topic") {
    const result = pauseSpeech();
    if (result) {
      state.pausedAtMs = result.pausedAtMs;
      update({ aiSpeaking: false, userSpeaking: true, pausedAtMs: result.pausedAtMs });
    }
  } else if (intent === "continue") {
    resumeFromPause();
  } else if (intent === "backchannel") {
    // Backchannel: do NOT interrupt, let AI continue
    update({ userSpeaking: true });
  } else {
    // irrelevant or unknown: do NOT interrupt here; coordinator decides whether to barge in
    update({ userSpeaking: false });
  }
  return intent;
};

/** Resume AI speech from a paused position using Playback Ledger. */
export const resumeFromPause = (): boolean => {
  if (state.pausedAtMs === null) return false;
  const pausedMs = state.pausedAtMs;
  state.pausedAtMs = null;
  void resumeSpeech(pausedMs).then((ok) => {
    if (ok) {
      update({ aiSpeaking: true, userSpeaking: false, pausedAtMs: null });
    } else {
      update({ aiSpeaking: false, userSpeaking: false });
    }
  }).catch(() => {
    update({ aiSpeaking: false, userSpeaking: false });
  });
  return true;
};

/** Start the turn-taking coordinator: enable VAD and wire candidate handler. */
export const startTurnTaking = async (): Promise<boolean> => {
  const ok = await startVad();
  if (!ok) return false;
  setVadCandidateHandler(handleVadCandidate);
  update({ aiSpeaking: getSpeechSnapshot().playing });
  return true;
};

/** Stop the turn-taking coordinator. */
export const stopTurnTaking = (): void => {
  stopVad();
  setVadCandidateHandler(null);
  update({ aiSpeaking: false, userSpeaking: false, pausedAtMs: null, interruptedAtMs: null, lastIntent: null });
};
