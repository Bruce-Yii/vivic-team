#!/usr/bin/env node
/**
 * 全场景自动化测试（v2）：在"11.后端修改测试"画布上逐条发送测试词。
 * 抓取方式（不依赖主界面 DOM 卡片层）：
 *   1) route 拦截 /api/intent*，保留原始响应体（JSON 或 SSE）；
 *   2) 每次发送后拉取 owner canvases，对比目标画布 cardsById 差异（真实落库结果）；
 *   3) 从页面正文提取 Vivic 的回复/澄清话术。
 * 输出 report.json / report.md，并在结束时用 /display 路由截图验证分区渲染。
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const BASE = (() => { const i = process.argv.indexOf("--base"); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1].replace(/\/+$/, "") : "https://vivic.edsionc.top"; })();
const CANVAS = "canvas_mvytb8db_b7babfe7";
const SPACE = "11.后端修改测试";
const TAG = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = join(HERE, "evidence", "scenario-batch-" + TAG);
mkdirSync(OUT, { recursive: true });
const requireFromWeb = createRequire(join(REPO, "work", "ui-server-source", "apps", "web", "package.json"));
const { chromium } = requireFromWeb("@playwright/test");

const session = JSON.parse(readFileSync(join(REPO, "work", "product-account-session.json"), "utf8"));
const cookiePair = String(session.cookie || "").split(";")[0].trim();

const args = process.argv.slice(2);
const limit = Number(args[args.indexOf("--limit") + 1] || 0);
const idsArg = args.includes("--ids") ? String(args[args.indexOf("--ids") + 1] || "") : "";
const wantedIds = new Set(idsArg.split(",").map((s) => s.trim()).filter(Boolean));
const cases = [
  // A 办公模板
  { id: "A1", group: "模板", text: "帮我开个会议纪要：预算评审，结论先按A方案推进，待办让小王出报价", create: true, sections: true },
  { id: "A2", group: "模板", text: "写个周报：本周完成登录改版和性能优化，下周计划做支付", create: true },
  { id: "A3", group: "模板", text: "做个项目计划：Q1 调研、Q2 开发、Q3 上线", create: true },
  { id: "A4", group: "模板", text: "列个待办清单：买菜、取快递、交电费", create: true },
  { id: "A5", group: "模板", text: "记一下决策记录：要不要上新的推荐算法，结论先灰度10%，风险是转化率波动", create: true },
  { id: "A6", group: "模板", text: "帮我做个项目复盘：目标完成80%，做得好的是交付节奏，问题是测试覆盖不足", create: true },
  { id: "A7", group: "模板", text: "整理阅读笔记：《原则》，作者瑞·达利欧，核心观点是极度透明", create: true },
  { id: "A8", group: "模板", text: "做个方案对比表：方案A成本低但慢，方案B成本高但快", create: true },
  // B 场景卡
  { id: "B1", group: "场景", text: "倒计时 2 分钟", create: true, type: "CountdownCard" },
  { id: "B2", group: "场景", text: "明天上午 9 点提醒我开会", create: true },
  { id: "B3", group: "场景", text: "帮我做下周二的工作计划：上午写周报、下午评审", create: true },
  { id: "B4", group: "场景", text: "做个项目路线图：Q1 调研、Q2 开发、Q3 上线", create: true, type: "RoadmapCard" },
  { id: "B5", group: "场景", text: "画个柱状图：1月120、2月150、3月90", create: true },
  { id: "B6", group: "场景", text: "整理三条科技新闻：AI 芯片发布、开源模型更新、手机新品", clarify: true, noCreate: true },
  { id: "B7", group: "场景", text: "做个时间线：2019 立项、2021 上线、2023 改版", create: true },
  { id: "B8", group: "场景", text: "记一句金句：慢慢来，比较快 —— 连岳", create: true },
  { id: "B9", group: "场景", text: "做个照片故事：周末露营，出发、搭帐篷、篝火", create: true },
  { id: "B10", group: "场景", text: "记录今天运动：早上跑步3公里、晚上游泳500米", create: true },
  { id: "B11", group: "场景", text: "目标进度：读完12本书，已完成7本", create: true },
  { id: "B12", group: "场景", text: "习惯打卡：每天背单词，本周一到周三做到了", create: true },
  { id: "B13", group: "场景", text: "书籍记录：《原则》瑞·达利欧，已读完，评分4.5", create: true },
  { id: "B14", group: "场景", text: "做11月日历：11月5日开会、11月12日体检", create: true },
  { id: "B15", group: "场景", text: "对比两个方案：A成本低但慢，B成本高但快", create: true },
  { id: "B16", group: "场景", text: "收藏网页：https://example.com 标题是示例网站", create: true },
  { id: "B17", group: "场景", text: "通知：服务器故障已恢复，级别成功", create: true },
  { id: "B18", group: "场景", text: "整理一篇文献：Attention Is All You Need，作者 Vaswani，2017", create: true },
  { id: "B19", group: "场景", text: "做个照片墙：海边、山顶、咖啡馆、夜景四张", clarifyOrCard: true },
  // C 工具操作（期望不新建卡片）
  { id: "C1", group: "操作", text: "显示全部卡片", noCreate: true },
  { id: "C2", group: "操作", text: "聚焦刚才那张会议纪要", noCreate: true },
  { id: "C3", group: "操作", text: "高亮刚才那张会议纪要", noCreate: true },
  { id: "C4", group: "操作", text: "把刚才创建的卡片固定住", noCreate: true },
  { id: "C5", group: "操作", text: "把刚才那张卡往右移一点", noCreate: true },
  { id: "C6", group: "操作", text: "自动整理一下画布", noCreate: true },
  { id: "C7", group: "操作", text: "撤销刚才那一步", noCreate: true },
  { id: "C8", group: "操作", text: "重做一次", noCreate: true, allowRestore: true },
  { id: "C9", group: "操作", text: "暂停那个倒计时", noCreate: true },
  { id: "C10", group: "操作", text: "继续刚才的倒计时", noCreate: true },
  { id: "C11", group: "操作", text: "把刚才那张会议纪要删了", noCreate: true, expectConfirm: true },
  { id: "C12", group: "操作", text: "恢复刚才的视图", noCreate: true },
  // D 多意图/复合
  { id: "D1", group: "多意图", text: "1. 创建一个半小时倒计时。2. 周四下午要去健身。3. 周四上午9点开会", minCards: 2 },
  { id: "D2", group: "多意图", text: "加个待办交周报，再来一个两分钟倒计时", minCards: 2 },
  { id: "D3", group: "复合", text: "聚焦刚才那张卡并把它固定住", noCreate: true },
  { id: "D4", group: "复合", text: "把所有卡片放一屏，然后按时间排一下", noCreate: true },
  // E 澄清/负向
  { id: "E1", group: "澄清", text: "这个帮我记一下", clarify: true, noCreate: true },
  { id: "E2", group: "澄清", text: "帮我安排一下", clarify: true, noCreate: true },
  { id: "E3", group: "澄清", text: "删了它", clarify: true, noCreate: true },
  { id: "E4", group: "聊天", text: "明天怎么样", noCreate: true },
  { id: "E5", group: "聊天", text: "你好", noCreate: true },
];
const selected = wantedIds.size > 0 ? cases.filter((c) => wantedIds.has(c.id)) : (limit > 0 ? cases.slice(0, limit) : cases);

async function getCanvas() {
  const r = await fetch(BASE + "/api/space/owner/canvases", { headers: { cookie: cookiePair } });
  const payload = JSON.parse(await r.text());
  const list = payload.canvases || payload;
  const target = list.find((c) => (c.record || c).id === CANVAS);
  return target ? target.record : null;
}
function cardSnapshot(record) {
  const map = new Map();
  for (const card of Object.values(record?.cardsById || {})) {
    map.set(card.id, { type: card.type, sections: Array.isArray(card.displayProps?.sections) ? card.displayProps.sections.length : 0, title: (card.displayProps?.title || card.displayProps?.headline || card.displayProps?.text || "").slice(0, 40) });
  }
  return map;
}
function parseBody(body) {
  const text = String(body || "");
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      const data = JSON.parse(line.slice(5).trim());
      if (data && typeof data === "object") {
        if (data.type === "result" || data.kind) Object.assign(result, data);
        if (data.feedback) result.feedback = data.feedback;
      }
    } catch {}
  }
  if (!Object.keys(result).length) {
    try { return JSON.parse(text); } catch { return null; }
  }
  return result;
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
await context.addCookies([{ name: cookiePair.slice(0, cookiePair.indexOf("=")), value: cookiePair.slice(cookiePair.indexOf("=") + 1), url: BASE, secure: true, httpOnly: true, sameSite: "Strict" }]);
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 160)));
// 不拦截请求（拦截会缓冲 SSE，导致假超时）。改为在页面内 tee fetch 的响应体：
// 只旁路记录，不改写返回给应用的流，因此应用行为与真人一致。
await context.addInitScript(() => {
  const original = window.fetch;
  window.__probe = { chunks: [] };
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const promise = original.apply(this, arguments);
    if (!/\/api\/intent/.test(url)) return promise;
    return promise.then((response) => {
      try {
        const [appStream, probeStream] = response.body.tee();
        (async () => {
          const reader = probeStream.getReader();
          const decoder = new TextDecoder();
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              window.__probe.chunks.push(decoder.decode(value, { stream: true }));
            }
          } catch { /* the app may abort the stream; partial body is still useful */ }
        })();
        return new Response(appStream, { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch { return response; }
    });
  };
});

const report = { canvas: CANVAS, space: SPACE, startedAt: new Date().toISOString(), cases: [], pageErrors };
try {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4500);
  for (let i = 0; i < 8; i += 1) {
    if (!(await page.locator("[data-vivic-online-onboarding='true']").count())) break;
    const primary = page.locator("button.vfs-workshop-start").first();
    if (await primary.count()) await primary.click({ force: true }).catch(() => {});
    await page.waitForTimeout(900);
  }
  await page.locator('[aria-label="切换 Space 存档"]').first().click({ force: true });
  await page.waitForTimeout(700);
  await page.locator('[aria-label="切换到' + SPACE + '存档"]').first().click({ force: true });
  await page.waitForTimeout(2500);
  await page.locator("button.vv4-keyboard").first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(900);
  const input = page.locator("input[aria-label='指令输入'], input.vivic-composer-input").first();
  if (!(await input.count())) throw new Error("composer not found");

  let snapshot = cardSnapshot(await getCanvas());
  for (const item of selected) {
    const started = Date.now();
    await page.evaluate(() => { window.__probe.chunks = []; }).catch(() => {});
    await input.click({ force: true });
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
    await page.keyboard.type(item.text, { delay: 6 });
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    // 等页面内 tee 到 result/JSON 响应（最多 30 秒）；不拦截请求，不会制造假超时
    const deadline = Date.now() + 30000;
    let raw = "";
    while (Date.now() < deadline) {
      raw = await page.evaluate(() => (window.__probe.chunks || []).join("")).catch(() => "");
      if (/event:\s*result/.test(raw) || /"kind"\s*:/.test(raw)) break;
      await page.waitForTimeout(250);
    }
    if (!raw) { await page.waitForTimeout(2000); raw = await page.evaluate(() => (window.__probe.chunks || []).join("")).catch(() => ""); }
    const parsed = parseBody(raw) || {};
    await page.waitForTimeout(1800);
    const record = await getCanvas();
    const current = cardSnapshot(record);
    const created = [...current.keys()].filter((id) => !snapshot.has(id)).map((id) => current.get(id));
    const removed = [...snapshot.keys()].filter((id) => !current.has(id));
    snapshot = current;
    const reply = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll("[data-vivic-chat] *, body *")].filter((el) => el.children.length === 0 && el.innerText && el.innerText.trim().length > 2);
      return nodes.map((el) => el.innerText.trim()).slice(-6).join(" | ").slice(-320);
    }).catch(() => "");
    const elapsed = Date.now() - started;

    let verdict = "PASS";
    let note = "";
    const sections = created.reduce((n, c) => n + (c.sections || 0), 0);
    if (item.clarify) {
      if (parsed?.kind === "clarify") { verdict = "PASS"; note = "澄清：" + String(parsed.message || "").slice(0, 40); }
      else if (created.length > 0) { verdict = "CHECK"; note = "未澄清，直接建卡 " + created.map((c) => c.type).join(","); }
      else { verdict = "CHECK"; note = "无卡且非澄清（kind=" + (parsed?.kind ?? "-") + "）"; }
    } else if (item.clarifyOrCard) {
      if (created.length > 0) { verdict = "PASS"; note = "直接建卡 " + created.map((c) => c.type).join(","); }
      else if (parsed?.kind === "clarify") { verdict = "CHECK"; note = "澄清：" + String(parsed.message || "").slice(0, 40); }
      else { verdict = "CHECK"; note = "无卡，kind=" + (parsed?.kind ?? "-"); }
    } else if (item.create) {
      if (created.length === 0) { verdict = "FAIL"; note = "未建卡"; }
      else if (item.sections && sections === 0) { verdict = "FAIL"; note = "无分区"; }
      else if (item.type && !created.some((c) => c.type === item.type)) { verdict = "CHECK"; note = "卡型不同: " + created.map((c) => c.type).join(","); }
    } else if (item.minCards) {
      if (created.length < item.minCards) { verdict = "FAIL"; note = "只建了 " + created.length + " 张"; }
    } else if (item.noCreate) {
      if (item.allowRestore && created.length > 0) { verdict = "PASS"; note = "重做恢复 " + created.map((c) => c.type).join(","); }
      else if (created.length > 0) { verdict = "FAIL"; note = "意外新建: " + created.map((c) => c.type).join(","); }
      else if (removed.length > 0) { verdict = "CHECK"; note = "删除了 " + removed.length + " 张卡"; }
      else if (item.expectConfirm && !/确认|确定|要删|是要/.test(reply + JSON.stringify(parsed))) { verdict = "CHECK"; note = "未看到确认话术"; }
    }
    const entry = {
      id: item.id, group: item.group, text: item.text, elapsedMs: elapsed,
      decision: parsed?.task?.decision || parsed?.decision || "", kind: parsed?.kind || "",
      message: String(parsed?.message || "").slice(0, 100),
      created, removedCount: removed.length, sections, reply, verdict, note,
    };
    report.cases.push(entry);
    console.log(`${verdict.padEnd(5)} ${item.id} ${elapsed}ms created=[${created.map((c) => c.type + (c.sections ? ":S" + c.sections : "")).join(",")}] ${note} ${item.text.slice(0, 20)}`);
  }
} catch (e) {
  report.fatal = String(e).slice(0, 300);
  console.log("FATAL", report.fatal);
} finally {
  report.finishedAt = new Date().toISOString();
  // 分区渲染视觉验证：/display 路由
  try {
    const display = await context.newPage();
    await display.goto(BASE + "/display?canvasId=" + CANVAS, { waitUntil: "domcontentloaded", timeout: 60000 });
    await display.waitForTimeout(9000);
    report.render = await display.evaluate(() => ({
      cards: document.querySelectorAll("[data-card-id]").length,
      sectionsBlocks: document.querySelectorAll("[data-vivic-sections]").length,
      titles: [...document.querySelectorAll(".vivic-sections-title")].map((t) => t.textContent).slice(0, 10),
    })).catch(() => null);
    await display.screenshot({ path: join(OUT, "display.png") }).catch(() => {});
    await display.close();
  } catch {}
  await browser.close();
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  const md = ["# 全场景测试结果 " + report.startedAt, "", "画布: `" + CANVAS + "`（" + SPACE + "）", ""];
  md.push("| # | 组 | 输入 | 落库卡 | 分区 | 回复/澄清 | 耗时 | 判定 | 备注 |");
  md.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const c of report.cases) {
    md.push(`| ${c.id} | ${c.group} | ${c.text.replace(/\|/g, "\\|")} | ${c.created.map((x) => x.type).join(",") || "-"} | ${c.sections || "-"} | ${(c.reply || c.message || "").replace(/\|/g, "\\|").slice(0, 80)} | ${c.elapsedMs}ms | ${c.verdict} | ${c.note} |`);
  }
  md.push("", "渲染验证: " + JSON.stringify(report.render), "pageErrors=" + pageErrors.length);
  writeFileSync(join(OUT, "report.md"), md.join("\n"));
  const pass = report.cases.filter((c) => c.verdict === "PASS").length;
  const check = report.cases.filter((c) => c.verdict === "CHECK").length;
  const fail = report.cases.filter((c) => c.verdict === "FAIL").length;
  console.log(`\nSUMMARY total=${report.cases.length} PASS=${pass} CHECK=${check} FAIL=${fail}`);
  console.log("OUT", OUT);
}
