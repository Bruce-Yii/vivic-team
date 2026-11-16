// UI-level evidence for "who paints the first sentence": load the real
// __vivicFirstFeedbackShim from work/first-feedback-frontend in Chromium against
// a local staging instance, and record the shim's own event trail.
//
// The browser cannot hold the production `__Host-` cookie locally (CDP rejects
// Secure host-prefixed cookies over loopback http), so the probe runs a tiny
// same-origin proxy: the page talks to 127.0.0.1:<proxy>, the proxy injects the
// account cookie and rewrites Origin to the staging origin. The cookie value is
// read at runtime from work/product-account-session.json and never printed.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const merge = path.resolve(here, "..");
const webRequire = createRequire(path.resolve(merge, "apps/web/package.json"));
const { chromium } = webRequire("@playwright/test");

const backend = process.env.STAGING_ORIGIN ?? "http://127.0.0.1:8791";
const proxyPort = Number(process.env.PROXY_PORT ?? 8794);
const text = process.env.PROBE_TEXT ?? "帮我整理一份会议纪要：议题是Q4预算评审，结论是下周一定稿";
const shimSource = fs.readFileSync(path.resolve(merge, "../first-feedback-frontend/shim/first-feedback-shim.js"), "utf8");
const { cookie } = JSON.parse(fs.readFileSync(path.resolve(merge, "../product-account-session.json"), "utf8"));
const out = { backend, proxy: `http://127.0.0.1:${proxyPort}`, text, shimVersion: null, authenticated: null,
  request: {}, events: [], firstFeedback: null, firstFeedbackSources: [], verdict: null, finalSlotText: null };

const proxy = http.createServer((req, res) => {
  const target = new URL(backend);
  const headers = { ...req.headers, cookie, origin: target.origin, host: `${target.hostname}:${target.port}` };
  const upstream = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method,
    headers }, response => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });
  upstream.on("error", error => { res.writeHead(502, { "content-type": "text/plain" }); res.end(`proxy error: ${error.message}`); });
  req.pipe(upstream);
});
await new Promise(resolve => proxy.listen(proxyPort, "127.0.0.1", resolve));

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? "C:\\Users\\12412\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe";
const browser = await chromium.launch({ headless: true, executablePath });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${proxyPort}/healthz`, { waitUntil: "domcontentloaded" });
  const runtime = await page.evaluate(async () => {
    const response = await fetch("/api/runtime");
    return { status: response.status, session: (await response.json().catch(() => null))?.session ?? null };
  });
  out.authenticated = runtime;

  await page.addScriptTag({ content: shimSource });
  out.shimVersion = await page.evaluate(() => window.__vivicFirstFeedbackShim?.version ?? null);
  await page.evaluate(() => {
    const slot = document.createElement("div");
    slot.setAttribute("data-vivic-command-feedback", "");
    slot.textContent = "正在理解你的指令…";
    document.body.appendChild(slot);
    window.__probeSlotText = () => slot.textContent;
  });

  const started = performance.now();
  const response = await page.evaluate(async (body) => {
    const r = await fetch("/api/intent", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body) });
    const json = await r.json().catch(() => null);
    return { status: r.status, kind: json?.kind,
      cards: json?.envelope?.actions?.flatMap(a => a.type === "card.create" ? [a.card.type] : []) ?? null,
      noteProps: json?.envelope?.actions?.flatMap(a => a.type === "card.create" && a.card.type === "NoteCard"
        ? [Object.keys(a.card.displayProps ?? {})] : [])[0] ?? null };
  }, { text, canvasContext: { canvasId: "shim-probe", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 },
    focusHistory: [], timeZone: "Asia/Shanghai", cards: [] } });
  out.request = { ...response, ms: Math.round(performance.now() - started) };
  out.events = await page.evaluate(() => window.__vivicFirstFeedbackShim?.events ?? []);
  out.finalSlotText = await page.evaluate(() => window.__probeSlotText());
} finally {
  await browser.close();
  await new Promise(resolve => proxy.close(resolve));
}

const firsts = out.events.filter(entry => entry.kind === "first-feedback");
out.firstFeedback = firsts[0] ?? null;
out.firstFeedbackSources = firsts.map(entry => ({ ms: entry.ms, source: entry.source, text: entry.text }));
out.eventKinds = out.events.map(entry => ({ t: entry.t, kind: entry.kind, source: entry.source, ms: entry.ms }));
out.verdict = out.firstFeedback ? out.firstFeedback.source
  : out.events.length ? "none (events but no first-feedback)" : "none";
fs.writeFileSync(path.resolve(merge, `logs/shim-ui-probe-${new URL(backend).port}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ backend, proxy: out.proxy, shimVersion: out.shimVersion, authenticated: out.authenticated,
  request: out.request, firstFeedback: out.firstFeedback, firstFeedbackSources: out.firstFeedbackSources,
  finalSlotText: out.finalSlotText, verdict: out.verdict, eventKinds: out.eventKinds }, null, 2));
