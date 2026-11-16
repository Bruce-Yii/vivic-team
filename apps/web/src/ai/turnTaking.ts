import { getSpeechSnapshot, pauseSpeech, resumeSpeech, recordBargeInCandidate, confirmBargeIn } from "./speech";
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
  listeners.forEach(l => l());
};

export const getTurnTakingState = (): TurnTakingState => state;
export const subscribeTurnTaking = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Classify a VAD candidate into a turn intent. This is a placeholder for
 * future semantic classification (text model or rule-based). For now, returns
 * "unknown" — the coordinator must not auto-act on raw VAD signals. */
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
  // VAD only produces candidate signals. Do NOT classify intent from audio level.
  // The coordinator must wait for ASR transcript before classifying.
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
    // irrelevant or unknown: do NOT interrupt
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

/** Start the turn-taking coordinator: enable VAD and wire candidate handler.
 * VAD only produces candidate signals; actual intent classification happens
 * after ASR transcription via handleUserTranscript(). */
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
}