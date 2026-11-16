// Local staging probe (no secrets printed or persisted): health, setup status,
// one streaming intent turn with per-frame timings, and speech.
//   STAGING_ORIGIN=http://127.0.0.1:8791 node scripts/staging-probe.mjs
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const merge = path.resolve(here, "..");
const sessionFile = path.resolve(merge, "../product-account-session.json");
const base = process.env.STAGING_ORIGIN ?? "http://127.0.0.1:8791";
const text = process.env.PROBE_TEXT ?? "帮我整理一份会议纪要：议题是Q4预算评审，结论是下周一定稿";
const { cookie } = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
const result = { base, text, steps: [] };
const step = (name, data) => { result.steps.push({ name, ...data }); };

const get = async (route) => {
  const started = performance.now();
  const response = await fetch(`${base}${route}`, { headers: { Origin: base, cookie } });
  const body = await response.text();
  return { status: response.status, ms: Math.round(performance.now() - started), body };
};

// 1) health
{
  const response = await fetch(`${base}/healthz`);
  step("healthz", { status: response.status, body: (await response.text()).slice(0, 160) });
}

// 2) authenticated setup status
{
  const r = await get("/api/setup/status");
  let body = null;
  try { body = JSON.parse(r.body); } catch { /* non-JSON */ }
  step("setup/status", { status: r.status, ms: r.ms, keys: body && typeof body === "object" ? Object.keys(body) : [],
    ready: body?.ready, providers: Array.isArray(body?.providers) ? body.providers.length : undefined });
}

// 3) one streaming intent turn, timestamps taken as each frame arrives
let sseRaw = "";
{
  const started = performance.now();
  const response = await fetch(`${base}/api/intent/stream`, { method: "POST",
    headers: { Origin: base, cookie, accept: "text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ text, canvasContext: { canvasId: "staging-probe", stage: "WORKSPACE",
      viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], timeZone: "Asia/Shanghai", cards: [] } }) });
  const frames = [];
  let eventName = "";
  let buffer = "";
  const decoder = new TextDecoder();
  sseRaw = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    sseRaw += decoder.decode(chunk.slice(), { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.startsWith("event:")) { eventName = line.slice(6).trim(); continue; }
      if (!line.startsWith("data:")) continue;
      const atMs = Math.round(performance.now() - started);
      let data = null;
      try { data = JSON.parse(line.slice(5).trim()); } catch { data = null; }
      const frame = { event: eventName, atMs };
      if (data && typeof data === "object") {
        if (typeof data.stage === "string") frame.stage = data.stage;
        if (typeof data.status === "string") frame.status = data.status;
        if (typeof data.feedback === "string") { frame.feedback = data.feedback.slice(0, 80); frame.feedbackSource = data.feedbackSource; }
        if (typeof data.kind === "string") frame.kind = data.kind;
        if (data.envelope) {
          frame.cardTypes = [...new Set(data.envelope.actions.flatMap(a => a.type === "card.create" ? [a.card.type] : []))];
          frame.actionTypes = [...new Set(data.envelope.actions.map(a => a.type))];
          frame.spokenText = typeof data.envelope.spokenText === "string" ? data.envelope.spokenText.slice(0, 120) : undefined;
          frame.noteProps = data.envelope.actions.flatMap(a => a.type === "card.create" && a.card.type === "NoteCard"
            ? [Object.keys(a.card.displayProps ?? {})] : [])[0];
          frame.noteTextHead = data.envelope.actions.flatMap(a => a.type === "card.create" && a.card.type === "NoteCard"
            && typeof a.card.displayProps?.text === "string" ? [a.card.displayProps.text.slice(0, 120)] : [])[0];
        }
        if (data.toolCalls !== undefined) frame.toolCalls = data.toolCalls;
        if (data.trace) { frame.traceRoute = data.trace.route; frame.provider = data.trace.legacyUsedProvider;
          frame.firstFeedbackMs = data.trace.firstFeedbackMs; }
      }
      frames.push(frame);
    }
  }
  const feedbackFrames = frames.filter(frame => frame.feedback);
  const resultFrame = frames.find(frame => frame.event === "result");
  step("intent/stream", {
    status: response.status,
    contentType: response.headers.get("content-type"),
    totalMs: Math.round(performance.now() - started),
    frameOrder: frames.map(frame => `${frame.event}${frame.stage ? ":" + frame.stage : ""}`),
    firstFeedback: feedbackFrames[0] ? { atMs: feedbackFrames[0].atMs, source: feedbackFrames[0].feedbackSource,
      text: feedbackFrames[0].feedback } : null,
    resultAtMs: resultFrame?.atMs,
    feedbackBeforeResult: feedbackFrames[0] && resultFrame ? feedbackFrames[0].atMs <= resultFrame.atMs : undefined,
    kind: resultFrame?.kind, toolCalls: resultFrame?.toolCalls, cardTypes: resultFrame?.cardTypes,
    actionTypes: resultFrame?.actionTypes, spokenText: resultFrame?.spokenText, noteProps: resultFrame?.noteProps,
    noteTextHead: resultFrame?.noteTextHead, route: resultFrame?.traceRoute, provider: resultFrame?.provider,
    traceFirstFeedbackMs: resultFrame?.firstFeedbackMs,
  });
  fs.writeFileSync(path.resolve(merge, `logs/sse-raw-${new URL(base).port}.txt`), sseRaw);
}

// 4) speech
{
  const started = performance.now();
  const response = await fetch(`${base}/api/speech`, { method: "POST",
    headers: { Origin: base, cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "本地预演语音检查。" }) });
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  step("speech", { status: response.status, contentType, bytes: buffer.length,
    ms: Math.round(performance.now() - started),
    bodyHead: contentType.includes("audio") ? undefined : buffer.toString("utf8").slice(0, 200) });
}

const outFile = path.resolve(merge, `logs/staging-probe-${new URL(base).port}.json`);
fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
