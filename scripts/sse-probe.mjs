// Streaming SSE probe: timestamps every event as it arrives (no credentials printed).
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const sessionFile = path.resolve(here, "../../product-account-session.json");
const base = process.env.STAGING_ORIGIN ?? "http://127.0.0.1:8791";
const text = process.env.PROBE_TEXT ?? "帮我整理一份会议纪要：议题是Q4预算评审，结论是下周一定稿";
const { cookie } = JSON.parse(fs.readFileSync(sessionFile, "utf8"));

const started = performance.now();
const response = await fetch(`${base}/api/intent/stream`, {
  method: "POST",
  headers: { Origin: base, cookie, "content-type": "application/json" },
  body: JSON.stringify({ text, canvasContext: { canvasId: "staging-canvas", stage: "WORKSPACE",
    viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [] } }),
});

const events = [];
let buffer = "";
let eventName = "";
const decoder = new TextDecoder();
for await (const chunk of response.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (line.startsWith("event:")) { eventName = line.slice(6).trim(); continue; }
    if (!line.startsWith("data:")) continue;
    const at = Math.round(performance.now() - started);
    let data;
    try { data = JSON.parse(line.slice(5).trim()); } catch { data = null; }
    const entry = { event: eventName, atMs: at };
    if (data && typeof data === "object") {
      if (typeof data.feedback === "string") entry.feedback = data.feedback.slice(0, 120);
      if (typeof data.stage === "string") entry.stage = data.stage;
      if (typeof data.status === "string") entry.status = data.status;
      if (typeof data.elapsedMs === "number") entry.elapsedMs = data.elapsedMs;
      if (data.kind) entry.kind = data.kind;
      if (data.envelope) {
        entry.cardTypes = [...new Set(data.envelope.actions.flatMap(action => action.type === "card.create" ? [action.card.type] : []))];
        entry.actionTypes = [...new Set(data.envelope.actions.map(action => action.type))];
        entry.spokenText = typeof data.envelope.spokenText === "string" ? data.envelope.spokenText.slice(0, 160) : undefined;
      }
      if (typeof data.message === "string") entry.message = data.message.slice(0, 160);
      if (data.trace && typeof data.trace === "object") {
        entry.route = data.trace.route;
        entry.provider = data.trace.legacyUsedProvider;
        entry.firstFeedbackMs = data.trace.firstFeedbackMs;
      }
    }
    events.push(entry);
  }
}

const feedback = events.filter(entry => entry.feedback);
const cards = events.filter(entry => entry.cardTypes?.length);
const result = events.find(entry => entry.event === "result");
const claims = ["已创建", "已完成", "搞定了", "已为你完成", "已经完成"];
const summary = {
  status: response.status,
  contentType: response.headers.get("content-type"),
  totalMs: Math.round(performance.now() - started),
  eventOrder: events.map(entry => entry.event),
  firstFeedback: feedback[0] ? { atMs: feedback[0].atMs, text: feedback[0].feedback } : null,
  firstCard: cards[0] ? { atMs: cards[0].atMs, cardTypes: cards[0].cardTypes } : null,
  feedbackBeforeCard: feedback[0] && cards[0] ? feedback[0].atMs <= cards[0].atMs : undefined,
  result: result ? { atMs: result.atMs, kind: result.kind, cardTypes: result.cardTypes,
    actionTypes: result.actionTypes, spokenText: result.spokenText, route: result.route, provider: result.provider,
    firstFeedbackMs: result.firstFeedbackMs } : null,
  firstSentenceClaims: [feedback[0]?.feedback, result?.spokenText].filter(Boolean).flatMap(sentence => claims.filter(phrase => sentence.includes(phrase))),
};
const outFile = path.resolve(here, "../logs/sse-probe.json");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
