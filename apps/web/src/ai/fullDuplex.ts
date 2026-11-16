import { getSpeechSnapshot, subscribeSpeech, duckSpeech, unduckSpeech } from "./speech";
import { classifyIntent, handleUserTranscript, resumeFromPause } from "./turnTaking";
import type { TaskProjection } from "./taskProjection";

import { AsrGatewayClient } from "./asrGatewayClient";

export type FullDuplexStatus =
  | "idle"
  | "starting"
  | "listening"
  | "speech"
  | "processing"
  | "error";

export interface FullDuplexSnapshot {
  enabled: boolean;
  status: FullDuplexStatus;
  userSpeaking: boolean;
  aiSpeaking: boolean;
  lastTranscript: string | null;
  lastIntent: string | null;
  error: string | null;
}

let snapshot: FullDuplexSnapshot = {
  enabled: false,
  status: "idle",
  userSpeaking: false,
  aiSpeaking: false,
  lastTranscript: null,
  lastIntent: null,
  error: null,
};
const listeners = new Set<() => void>();
const update = (patch: Partial<FullDuplexSnapshot>) => {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((l) => l());
};

export const getFullDuplexSnapshot = (): FullDuplexSnapshot => snapshot;
export const subscribeFullDuplex = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

let enabled = false;
let generation = 0;
let stream: MediaStream | null = null;
let context: AudioContext | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let recorder: AudioWorkletNode | null = null;
let sink: GainNode | null = null;

const THRESHOLD = 0.015;

let inSpeech = false;
let segmentWasSpeaking = false;
let segmentTaskId: string | null = null;
let currentTaskProjection: TaskProjection | null = null;

let onCommand: ((text: string, options?: { cancelRunning?: boolean }) => void) | null = null;
export const setFullDuplexCommandHandler = (handler: ((text: string, options?: { cancelRunning?: boolean }) => void) | null) => {
  onCommand = handler;
};

let onCancelTaskById: ((taskId: string) => void) | null = null;
export const setFullDuplexCancelTaskByIdHandler = (handler: ((taskId: string) => void) | null) => {
  onCancelTaskById = handler;
};

let getTaskId: (() => string | null) | null = null;
export const setFullDuplexTaskIdGetter = (handler: (() => string | null) | null) => {
  getTaskId = handler;
};

export const setFullDuplexTaskProjection = (projection: TaskProjection | null) => {
  currentTaskProjection = projection;
};

export const getFullDuplexTaskProjection = (): TaskProjection | null => currentTaskProjection;

let gatewayClient: AsrGatewayClient | null = null;



const releaseCapture = () => {
  if (recorder) { recorder.port.onmessage = null; try { recorder.disconnect(); } catch {} try { recorder.port.close(); } catch {} }
  recorder = null;
  source?.disconnect(); source = null;
  sink?.disconnect(); sink = null;
  stream?.getTracks().forEach((t) => t.stop()); stream = null;
  const old = context; context = null; if (old && old.state !== "closed") void old.close().catch(() => undefined);
  if (gatewayClient) { gatewayClient.close(); gatewayClient = null; }
};

const captureError = (error: unknown): string => {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "麦克风权限未开启。";
  if (name === "NotFoundError") return "没有找到麦克风。";
  return "无法启动全双工监听。";
};

export const startFullDuplex = async (): Promise<boolean> => {
  if (enabled) return true;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    update({ status: "error", error: "浏览器不支持安全录音。" });
    return false;
  }
  const token = ++generation;
  update({ status: "starting", error: null });
  let acquired: MediaStream | null = null;
  let audio: AudioContext | null = null;
  try {
    audio = new AudioContext({ sampleRate: 16000 });
    await audio.resume();
    if (token !== generation) { await audio.close(); return false; }
    context = audio;
    acquired = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    if (token !== generation) { acquired.getTracks().forEach((t) => t.stop()); if (audio.state !== "closed") await audio.close(); return false; }
    stream = acquired;
    await audio.audioWorklet.addModule("/audio-capture-worklet.js");
    if (token !== generation) { acquired.getTracks().forEach((t) => t.stop()); return false; }

    gatewayClient = new AsrGatewayClient({
      onPartial: (text: string) => {
        if (token !== generation) return;
        update({ lastTranscript: text, status: "processing" });
      },
      onFinal: (text: string) => {
        if (token !== generation) return;
        if (!text.trim()) { update({ status: "listening" }); return; }
        update({ lastTranscript: text, status: "listening" });
        const aiSpeakingNow = getSpeechSnapshot().status === "playing" || getSpeechSnapshot().status === "loading";
        if (aiSpeakingNow) {
          const intent = handleUserTranscript(text);
          update({ lastIntent: intent });
          if (intent === "stop" || intent === "cancel_task") {
            if (intent === "cancel_task" && segmentTaskId && onCancelTaskById && currentTaskProjection?.isTerminal !== true) onCancelTaskById(segmentTaskId);
          } else if (intent === "new_constraint" || intent === "new_topic") {
            unduckSpeech();
            // Store constraint in Working Context without cancelling or creating new task
            // The original Hosted Task continues; constraint will be applied on next turn
          } else if (intent === "continue") {
            unduckSpeech();
          } else {
            unduckSpeech();
          }
        } else {
          const intent = classifyIntent(text);
          if (intent === "backchannel" || intent === "irrelevant" || intent === "unknown") {
            unduckSpeech();
            return;
          }
          if (intent === "continue") { resumeFromPause(); unduckSpeech(); return; }
          if (intent === "stop") { unduckSpeech(); return; }
          if (intent === "cancel_task") {
            if (segmentTaskId && onCancelTaskById && currentTaskProjection?.isTerminal !== true) onCancelTaskById(segmentTaskId);
            unduckSpeech();
            return;
          }
          if (onCommand) onCommand(text);
        }
      },
      onError: (_code: string, message: string) => {
        if (token !== generation) return;
        update({ error: message, status: "listening" });
      },
      onEnded: (_reason: string) => {
        if (token !== generation) return;
        update({ status: "listening" });
      },
    });

    const connected = await gatewayClient.connect();
    if (token !== generation) { gatewayClient.close(); gatewayClient = null; return false; }
    if (!connected) {
      gatewayClient.close(); gatewayClient = null;
      releaseCapture();
      update({ status: "error", error: "ASR Gateway 连接失败", enabled: false });
      enabled = false;
      return false;
    }

    recorder = new AudioWorkletNode(audio, "vivic-pcm-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    recorder.port.onmessage = (event) => {
      if (token !== generation) return;
      if (event.data?.stopped) return;
      if (!(event.data instanceof Float32Array)) return;
      const data = event.data as Float32Array;

      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      const speaking = rms > THRESHOLD;

      if (speaking) {
        if (!inSpeech) {
          inSpeech = true;
          segmentWasSpeaking = getSpeechSnapshot().status === "playing" || getSpeechSnapshot().status === "loading";
          segmentTaskId = getTaskId ? getTaskId() : null;
          if (segmentWasSpeaking) duckSpeech();
          update({ userSpeaking: true, status: "speech" });
        }
      } else {
        if (inSpeech) {
          inSpeech = false;
          if (gatewayClient && gatewayClient.isConnected()) gatewayClient.commit();
          update({ userSpeaking: false, status: "listening" });
        }
      }

      if (gatewayClient && gatewayClient.isConnected()) {
        gatewayClient.sendAudio(data);
      }
    };
    source = audio.createMediaStreamSource(acquired);
    sink = audio.createGain(); sink.gain.value = 0;
    source.connect(recorder); recorder.connect(sink); sink.connect(audio.destination);

    enabled = true;
    update({ enabled: true, status: "listening", error: null });
    const unsub = subscribeSpeech(() => {
      const s = getSpeechSnapshot();
      const ai = s.status === "playing" || s.status === "loading";
      update({ aiSpeaking: ai });
    });
    (window as any).__fd_unsub = unsub;
    return true;
  } catch (error) {
    acquired?.getTracks().forEach((t) => t.stop());
    if (audio && audio !== context && audio.state !== "closed") void audio.close().catch(() => undefined);
    if (token !== generation) return false;
    releaseCapture();
    update({ status: "error", error: captureError(error), enabled: false });
    enabled = false;
    return false;
  }
};

export const stopFullDuplex = (): void => {
  generation++;
  enabled = false;
  if ((window as any).__fd_unsub) { try { (window as any).__fd_unsub(); } catch {} (window as any).__fd_unsub = null; }
  if (gatewayClient) { gatewayClient.close(); gatewayClient = null; }
  releaseCapture();
  update({ enabled: false, status: "idle", userSpeaking: false, aiSpeaking: false });
};

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", stopFullDuplex);
}
