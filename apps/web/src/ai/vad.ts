export interface VadSnapshot {
  active: boolean;
  level: number;
  threshold: number;
  speaking: boolean;
}

let snapshot: VadSnapshot = { active: false, level: 0, threshold: 0.02, speaking: false };
const listeners = new Set<() => void>();
let context: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let stream: MediaStream | null = null;
let rafId: number | null = null;

export const getVadSnapshot = (): VadSnapshot => snapshot;
export const subscribeVad = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

const update = (patch: Partial<VadSnapshot>) => {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach(l => l());
};

export const setVadThreshold = (threshold: number) => {
  update({ threshold: Math.max(0.001, Math.min(1, threshold)) });
};

/** VAD only produces candidate signals. It does NOT directly trigger barge-in.
 * The turn-taking coordinator decides whether to act on the candidate. */
export type VadCandidate = { level: number; threshold: number; timestamp: number };
export type VadCandidateHandler = (candidate: VadCandidate) => void;
let candidateHandler: VadCandidateHandler | null = null;

export const setVadCandidateHandler = (handler: VadCandidateHandler | null) => {
  candidateHandler = handler;
};


export const startVad = async (): Promise<boolean> => {
  if (snapshot.active) return true;
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") return false;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    context = new AudioContext({ sampleRate: 16000 });
    await context.resume();
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);
    update({ active: true, speaking: false });
    const dataArray = new Float32Array(analyser.fftSize);
    const checkLevel = () => {
      if (!analyser || !snapshot.active) return;
      analyser.getFloatTimeDomainData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
      const rms = Math.sqrt(sum / dataArray.length);
      const speaking = rms > snapshot.threshold;
      if (speaking && !snapshot.speaking) {
        update({ level: rms, speaking: true });
        if (candidateHandler) {
          candidateHandler({ level: rms, threshold: snapshot.threshold, timestamp: performance.now() });
        }
      } else {
        update({ level: rms, speaking });
      }
      rafId = requestAnimationFrame(checkLevel);
    };
    rafId = requestAnimationFrame(checkLevel);
    return true;
  } catch {
    stopVad();
    return false;
  }
};

export const stopVad = (): void => {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  source?.disconnect(); source = null;
  analyser = null;
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  const old = context; context = null; if (old && old.state !== "closed") void old.close().catch(() => undefined);
  update({ active: false, level: 0, speaking: false });
}