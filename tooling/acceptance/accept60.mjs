import fs from "node:fs";
import path from "node:path";
import { CLARIFY_EXPECTED, evaluate } from "./accept60-rules.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ROOT = path.join(HERE, "..", "..", "..");
// Default output stays next to this script; a run against a non-production base
// (e.g. a local staging instance) can redirect artifacts so the baseline files
// in this directory are never overwritten.
const OUT = process.env.VIVIC_ACCEPT_OUT?.trim() ? path.resolve(process.env.VIVIC_ACCEPT_OUT.trim()) : HERE;
fs.mkdirSync(path.join(OUT, "accept60-raw"), { recursive: true });
const CASES = JSON.parse(fs.readFileSync(path.join(ROOT, "work", "scenarios", "scenarios-20261031.json"), "utf8"));
const DATASET = JSON.parse(fs.readFileSync(path.join(ROOT, "work", "vivic-routing", "evals", "decision", "dataset.json"), "utf8"));
const session = JSON.parse(fs.readFileSync(path.join(ROOT, "work", "product-account-session.json"), "utf8"));
const COOKIE = session.cookie.split(";")[0].trim();
// Target base defaults to the live product origin; VIVIC_ACCEPT_BASE points the
// same 60 scenarios at another deployment (e.g. a local staging instance).
const BASE = (process.env.VIVIC_ACCEPT_BASE?.trim() || "https://vivic.edsionc.top").replace(/\/+$/, "");
const ONLY = process.argv.find(a => a.startsWith("--only="))?.slice(7);
const LIMIT = Number(process.argv.find(a => a.startsWith("--limit="))?.slice(8) ?? 0);

const CANVAS_ID = "canvas_accept60_20261031";
const now = Date.now();
const cards = DATASET.canvas.cards.map(c => {
  const base = { id: c.id, type: c.type, aliases: [c.title], displayProps: {}, sourceDataSummary: {},
    surface: "user", layout: { x: c.x, y: c.y, width: 360, height: 240, pinned: false } };
  if (c.type === "TodoCard") base.displayProps = { title: c.title, items: c.items.map((text, i) => ({ id: `i${i}`, text, done: false })) };
  else if (c.type === "NoteCard") base.displayProps = { title: c.title, text: c.text };
  else if (c.type === "CountdownCard") base.displayProps = { title: c.title, remaining: c.remaining };
  else if (c.type === "WeatherCard") base.displayProps = { title: c.title, city: "上海" };
  else base.displayProps = { title: c.title, points: c.points ?? [] };
  return base;
});
const canvasContext = { canvasId: CANVAS_ID, version: 1, stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 },
  focusHistory: [DATASET.canvas.focused], timeZone: "Asia/Shanghai", totalCardCount: cards.length, cards };

async function run(sc) {
  const body = { text: sc.text, canvasContext, extensionDefinitions: [] };
  const attempts = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    let status = null, json = null, error = null;
    try {
      const res = await fetch(`${BASE}/api/intent`, { method: "POST", signal: controller.signal,
        headers: { "content-type": "application/json", cookie: COOKIE, origin: BASE,
          referer: `${BASE}/control`, "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0" },
        body: JSON.stringify(body) });
      status = res.status;
      json = await res.json().catch(() => null);
    } catch (e) { error = e.message; }
    clearTimeout(timer);
    const elapsedMs = Date.now() - started;
    attempts.push({ status, elapsedMs });
    if (status !== 429) return { status, json, error, elapsedMs, attempts, firstCardMs: elapsedMs };
    // The product returns {"code":"rate-limit"} under load; back off and retry the same text.
    await new Promise(r => setTimeout(r, 15000 * (attempt + 1)));
  }
  return { status: 429, json: null, error: "rate-limited after retries", elapsedMs: 0, attempts, firstCardMs: null };
}

const FROM = process.argv.find(a => a.startsWith("--from="))?.slice(7);
const list = CASES.scenarios.filter(s => (!ONLY || s.id === ONLY) && (!FROM || Number(s.id.slice(3)) >= Number(FROM.slice(3)))).slice(0, LIMIT || undefined);
const results = [];
fs.writeFileSync(path.join(OUT, "accept60-progress.log"), `start ${new Date().toISOString()} cases=${list.length}\n`);
for (const sc of list) {
  const r = await run(sc);
  const ev = evaluate(sc, r);
  const row = { id: sc.id, text: sc.text, expected: { route: sc.expected_route, routes: sc.routes ?? null,
    cards: sc.expected_card_types, target: sc.expected_target ?? null, clarify: CLARIFY_EXPECTED.has(sc.id) },
    http: r.status, elapsedMs: r.elapsedMs, firstCardMs: r.firstCardMs, error: r.error, ...ev,
    responseKind: r.json?.kind ?? null, raw: r.json };
  results.push(row);
  fs.writeFileSync(path.join(OUT, "accept60-raw", `${sc.id}.json`), JSON.stringify(row, null, 2));
  fs.appendFileSync(path.join(OUT, "accept60-progress.log"), `${sc.id} ${row.verdict} route=${row.route} cards=${row.createdTypes.join(",")} planner=${row.plannerCalls} ${row.elapsedMs}ms\n`);
  console.log(`${sc.id} ${row.verdict} kind=${row.kind} route=${row.route} cards=[${row.createdTypes}] planner=${row.plannerCalls} ${row.elapsedMs}ms`);
  await new Promise(r => setTimeout(r, 3500));
}

const pass = results.filter(r => r.verdict.startsWith("pass"));
const fails = results.filter(r => !r.verdict.startsWith("pass"));
const productChanges = results.filter(r => r.productChange === true);
const summary = { ranAt: new Date().toISOString(), total: results.length, passed: pass.length, failed: fails.length,
  // 口径（实现见 accept60-rules.mjs）：expected_card_types 是"任一合格"，不是集合全等；
  // notes 允许"一次提交"的用例（sc-47）记为产品变化而不是失败。
  cardRule: "any-of: actual card types must be a non-empty subset of expected_card_types",
  clarifyRule: "expected clarify, unless the scenario notes allow a single submission (then it is a product change)",
  productChanges: productChanges.map(r => ({ id: r.id, verdict: r.verdict, cards: r.createdTypes })),
  canvasId: CANVAS_ID, model: "deepseek-chat (main) / decision router mode=on, 4B gateway unconfigured",
  failList: fails.map(f => ({ id: f.id, verdict: f.verdict, failed: f.failed, expected: f.expected, route: f.route,
    cards: f.createdTypes, message: f.message.slice(0, 160) })),
  plannerTotal: results.reduce((s, r) => s + (r.plannerCalls ?? 0), 0),
  results: results.map(r => ({ id: r.id, verdict: r.verdict, kind: r.kind, route: r.route, clauseRoutes: r.clauseRoutes,
    createdTypes: r.createdTypes, targetIds: r.targetIds, plannerCalls: r.plannerCalls, directClauses: r.directClauses,
    spoken: r.spoken, message: r.message, firstLen: r.firstLen, elapsedMs: r.elapsedMs, expected: r.expected, failed: r.failed,
    notes: r.notes, productChange: r.productChange === true })) };
fs.writeFileSync(path.join(OUT, "accept60-summary-partial.json"), JSON.stringify(summary, null, 2));
console.log(`\nTOTAL ${summary.total} PASS ${summary.passed} FAIL ${summary.failed} plannerCalls ${summary.plannerTotal}`
  + `${productChanges.length ? ` productChanges ${productChanges.length} (${productChanges.map(r => r.id).join(",")})` : ""}`);
