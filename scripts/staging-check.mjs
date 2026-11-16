// Local staging probe for the merged backend. Never prints or persists credentials.
// Reads the account cookie from work/product-account-session.json at runtime only.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const sessionFile = path.resolve(here, "../../product-account-session.json");
const base = process.env.STAGING_ORIGIN ?? "http://127.0.0.1:8791";
const origin = base;
const { cookie } = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
const results = { base, steps: [] };
const step = (name, data) => { results.steps.push({ name, ...data }); };

const headers = (extra = {}) => ({ Origin: origin, ...extra });

async function timed(name, fn) {
  const started = performance.now();
  try {
    const value = await fn();
    step(name, { ok: true, ms: Math.round(performance.now() - started), ...value });
    return value;
  } catch (error) {
    step(name, { ok: false, ms: Math.round(performance.now() - started), error: String(error?.message ?? error).slice(0, 300) });
    return undefined;
  }
}

// 1) public health
await timed("healthz", async () => {
  const response = await fetch(`${base}/healthz`);
  const text = await response.text();
  return { status: response.status, body: text.slice(0, 200) };
});

// 2) authenticated setup status
await timed("setup/status", async () => {
  const response = await fetch(`${base}/api/setup/status`, { headers: headers({ cookie }) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  const keys = body && typeof body === "object" ? Object.keys(body) : [];
  return {
    status: response.status,
    keys,
    ready: body?.ready,
    providers: Array.isArray(body?.providers) ? body.providers.length
      : body?.providers && typeof body.providers === "object" ? Object.keys(body.providers).length : undefined,
    bodyHead: text.slice(0, 300),
  };
});

// 3) intent stream: create a meeting-minutes (office template) card and time the first feedback event vs card event
const intentBody = {
  text: "帮我整理一份会议纪要：议题是Q4预算评审，结论是下周一定稿",
  canvasContext: {
    canvasId: "staging-canvas",
    stage: "WORKSPACE",
    viewport: { x: 0, y: 0, zoom: 1 },
    focusHistory: [],
    cards: [],
  },
  deviceLocation: undefined,
};
await timed("intent/stream", async () => {
  const started = performance.now();
  const response = await fetch(`${base}/api/intent/stream`, {
    method: "POST",
    headers: headers({ cookie, "content-type": "application/json" }),
    body: JSON.stringify(intentBody),
  });
  const events = [];
  const text = await response.text();
  let firstEventMs;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("event:")) continue;
    const name = line.slice(6).trim();
    if (firstEventMs === undefined) firstEventMs = Math.round(performance.now() - started);
    events.push({ event: name, atMs: Math.round(performance.now() - started) });
  }
  // SSE payload scan for timing marks and claimed wording (data lines only).
  const dataLines = text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim());
  const firstFeedback = events.find(entry => entry.event === "feedback");
  const firstCard = events.find(entry => entry.event === "card" || entry.event === "result");
  const joined = dataLines.join("\n");
  const claims = ["已创建", "已完成", "搞定了", "已为你完成"].filter(phrase => joined.includes(phrase));
  let resultKind;
  try {
    const last = dataLines.filter(Boolean).at(-1);
    if (last) resultKind = JSON.parse(last)?.kind ?? JSON.parse(last)?.result?.kind;
  } catch { /* not a JSON result line */ }
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    eventOrder: events.map(entry => entry.event).slice(0, 12),
    firstEventMs,
    firstFeedbackMs: firstFeedback?.atMs,
    firstCardMs: firstCard?.atMs,
    feedbackBeforeCard: firstFeedback && firstCard ? firstFeedback.atMs <= firstCard.atMs : undefined,
    claimedCompletionWording: claims,
    resultKind,
    bodyChars: text.length,
    bodyHead: text.slice(0, 400),
  };
});

// 4) speech synthesis (only if a TTS key is available to the session)
await timed("speech", async () => {
  const response = await fetch(`${base}/api/speech`, {
    method: "POST",
    headers: headers({ cookie, "content-type": "application/json" }),
    body: JSON.stringify({ text: "本地预演语音检查。" }),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  let body = "";
  if (!String(response.headers.get("content-type") ?? "").includes("audio")) body = buffer.toString("utf8").slice(0, 300);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    bytes: buffer.length,
    bodyHead: body,
  };
});

const outFile = path.resolve(here, "../logs/staging-results.json");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
