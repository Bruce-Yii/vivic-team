// Reproduction probe: send a meeting-minutes sentence through the patched frontend
// preview (default :5186 -> backend :8792) and capture the whole chain:
//   SSE/JSON intent envelope -> owner canvas PUT body -> stored owner canvases record.
// The account cookie is read from work/product-account-session.json at runtime and never printed.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const merge = path.resolve(here, "..");
const webRequire = createRequire(path.resolve(merge, "apps/web/package.json"));
const { chromium } = webRequire("@playwright/test");
const sessionFile = path.resolve(merge, "../product-account-session.json");
const { cookie } = JSON.parse(fs.readFileSync(sessionFile, "utf8"));

const preview = process.env.PREVIEW_ORIGIN ?? "http://127.0.0.1:5186";
const backend = process.env.STAGING_ORIGIN ?? "http://127.0.0.1:8792";
const text = process.env.PROBE_TEXT ?? "帮我开个会议纪要：预算评审，结论先按A方案推进，待办让小王出报价";
const out = { preview, backend, text, intent: null, ownerPut: null, stored: null, errors: [] };

const cardSummary = (card) => card && ({
  id: card.id, type: card.type, displayPropsKeys: card.displayProps ? Object.keys(card.displayProps) : null,
  textHead: typeof card.displayProps?.text === "string" ? card.displayProps.text.slice(0, 160) : null,
  sections: Array.isArray(card.displayProps?.sections) ? card.displayProps.sections.length : null,
  sourceDataKeys: card.sourceData ? Object.keys(card.sourceData) : null, template: card.sourceData?.template,
});

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? "C:\\Users\\12412\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe";
const browser = await chromium.launch({ headless: true, executablePath });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("pageerror", error => out.errors.push(String(error.message).slice(0, 160)));
  page.on("response", async response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/intent")) {
      try {
        const body = await response.text();
        let result = null;
        for (const line of body.split(/\r?\n/)) if (line.startsWith("data:")) {
          try { const value = JSON.parse(line.slice(5).trim()); if (value?.kind) result = value; } catch { /* partial */ }
        }
        const cards = (result?.envelope?.actions ?? []).filter(action => action.type === "card.create").map(action => action.card);
        out.intent = { path: url.pathname, status: response.status(), resultKind: result?.kind, toolCalls: result?.toolCalls,
          cardTypes: cards.map(card => card.type), cards: cards.map(cardSummary) };
      } catch (error) { out.errors.push(`intent read: ${error.message}`.slice(0, 160)); }
    }
  });
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/space/owner/canvases") && request.method() === "PUT") {
      try {
        const body = JSON.parse(request.postData() ?? "null");
        const cards = body?.record?.cardsById ? Object.values(body.record.cardsById) : [];
        out.ownerPut = { path: url.pathname, cardCount: cards.length,
          cards: cards.map(cardSummary).filter(card => card.type === "NoteCard") };
      } catch (error) { out.errors.push(`put parse: ${error.message}`.slice(0, 160)); }
    }
  });

  await page.goto(`${preview}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(9000);
  for (let i = 0; i < 5; i++) {
    if (!(await page.locator("[data-vivic-online-onboarding='true']").count())) break;
    const start = page.locator("button.vfs-workshop-start").first();
    if (await start.count()) await start.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1600);
  }
  await page.waitForTimeout(2000);
  const keyboard = page.locator("button.vv4-keyboard, [aria-label='切换为文字输入']").first();
  if (await keyboard.count()) { await keyboard.click({ force: true }).catch(() => {}); await page.waitForTimeout(1000); }
  const composer = page.locator("input[aria-label='指令输入'], input.vivic-composer-input, textarea").first();
  await composer.fill(text).catch(() => {});
  await page.waitForTimeout(300);
  await composer.press("Enter").catch(() => {});
  // Let the intent finish, the owner canvas save fire and any confirmation settle.
  await page.waitForTimeout(Number(process.env.WAIT_MS ?? 30000));
  out.cardsInDom = await page.locator("[data-card-id]").count();
  out.pageText = (await page.evaluate(() => document.body.innerText.replace(/\n+/g, " | "))).slice(-600);
  out.pageSectionsDom = await page.locator("[data-vivic-sections], .vivic-sections, [data-sections]").count();
} finally {
  await browser.close();
}

// Stored record, straight from the backend.
try {
  const response = await fetch(`${backend}/api/space/owner/canvases`, { headers: { Origin: backend, cookie } });
  const list = await response.json();
  out.storedStatus = response.status;
  const canvases = Array.isArray(list) ? list : list?.canvases ?? [];
  const records = [];
  for (const entry of canvases) {
    const id = entry?.id ?? entry?.canvasId;
    if (!id) continue;
    const one = await fetch(`${backend}/api/space/owner/canvases/${id}`, { headers: { Origin: backend, cookie } });
    const record = await one.json();
    const cards = record?.record?.cardsById ? Object.values(record.record.cardsById) : [];
    records.push({ id, cards: cards.map(cardSummary).filter(card => card.type === "NoteCard") });
  }
  out.stored = records;
} catch (error) { out.errors.push(`stored read: ${error.message}`.slice(0, 160)); }

fs.writeFileSync(path.resolve(merge, "logs/repro-sections-persist.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
