// Shared judging logic for the 60-scenario acceptance run.
// Input: a stored row from accept60-raw/*.json (it keeps the raw product response).
// 卡型与 clarify 两层统一走 accept60-rules.mjs，避免两套口径。
import { cardsLayer, clarifyLayer } from "./accept60-rules.mjs";
const CONTRACT_WORDS = /\b(NoteCard|TodoCard|CountdownCard|WeatherCard|NewsCard|AnswerCard|SearchResultCard|TableCard|ChartCard|WeeklyScheduleCard|ComparisonCard|ActionEnvelope|HostOperation|schemaVersion|card\.create|card\.update|canvas\.fit)\b/;
export const CLARIFY_EXPECTED = new Set(["sc-31", "sc-47", "sc-48", "sc-49", "sc-55", "sc-56", "sc-57", "sc-58", "sc-59", "sc-60"]);
// sc-52 left on 2026-11-05 with accept60-rules.mjs: a decided action + a clarify may
// share one batch (NoteCard + "倒计时设多久"), so it is no longer a clarify-only case.
const CARD_TYPE_ALIASES = { AnswerCard: "NewsCard" };
const TITLES = { todo_week: "本周待办", todo_shop: "购物清单", note_meeting: "会议记录", note_book: "读书笔记",
  cd_water: "喝水提醒", weather_sh: "上海天气", answer_google: "Google 公司介绍" };
// Host operations carry the route in their own vocabulary; the decision trace is empty for them.
const HOST_ROUTE = { "history.undo": "undo", "history.redo": "undo", "card.move": "arrange", "card.arrange": "arrange",
  "card.delete": "delete", "card.focus": "focus", "card.update": "edit", "card.highlight": "highlight",
  "canvas.fit": "overview", "canvas.restore": "restore" };
const GENERIC_CLARIFY = /没能形成可靠参数|换一种说法|请补充内容/;
const WHICH_CARD = /哪一张|哪张卡|哪个卡片|是指哪/;

export function judge(row) {
  const sc = row.expected;
  const j = row.raw ?? {};
  const trace = j.trace ?? null;
  const hostOp = j.hostOperation ?? null;
  const actions = j.envelope?.actions ?? [];
  const created = actions.filter(a => a.type === "card.create").map(a => a.card?.type).filter(Boolean)
    .map(t => CARD_TYPE_ALIASES[t] ?? t);
  const targets = actions.filter(a => a.targetId).map(a => a.targetId);
  if (hostOp?.targetId) targets.push(hostOp.targetId);
  const kind = j.kind ?? null;
  const message = j.message ?? "";
  const spoken = j.envelope?.spokenText ?? "";
  const clarifyExpected = row.clarify === true || CLARIFY_EXPECTED.has(row.id);
  const clauseRoutes = (trace?.decisions ?? []).map(d => d.route ?? null);
  const tracedRoute = trace?.route ?? null;
  const actionRoutes = (trace?.decisions ?? []).map(d => d.route).filter(Boolean);
  const hostRoute = hostOp?.kind ? (HOST_ROUTE[hostOp.kind] ?? null) : null;
  const gotRoutes = clauseRoutes.length ? clauseRoutes : (tracedRoute ? [tracedRoute] : (hostRoute ? [hostRoute] : []));
  const layers = {};
  const notes = [];

  // 4B 决策路由自 2026-11-03 关闭：没有 trace.route 的跑批里路由层不可观测，记 N/A，
  // 与 accept60-rules.mjs 一致；带 trace 的历史跑批口径不变。
  if (!trace) layers.route = true;
  else if (sc.routes) layers.route = gotRoutes.length === sc.routes.length && sc.routes.every((r, i) => gotRoutes[i] === r);
  else layers.route = tracedRoute === sc.route || kind === sc.route || actionRoutes.includes(sc.route)
    || hostRoute === sc.route || gotRoutes[0] === sc.route;

  const createdSet = [...new Set(created)].sort();
  const expectedSet = [...new Set((sc.cards ?? []).map(t => CARD_TYPE_ALIASES[t] ?? t))].sort();
  // "任一合格"（sc-18 notes）而不是集合全等：实际卡型必须是期望集合的非空子集。
  const cards = cardsLayer(sc.cards ?? [], created, row.card_optional === true || sc.card_optional === true);
  layers.cards = cards.ok;
  if (!layers.cards && expectedSet.length && createdSet.length) notes.push("卡型不在期望集合内：" + createdSet.filter(t => !expectedSet.includes(t)).join(","));

  const isClarify = kind === "clarify" || Boolean(j.task?.clarification);
  const uniqueTarget = sc.target ? TITLES[sc.target] ?? null : null;
  const namesTarget = Boolean(uniqueTarget && message.includes(uniqueTarget));
  // Confirmation ("确定删除「读书笔记」吗") is correct behaviour; "没能形成可靠参数" / "哪一张" is not.
  const confirmOk = Boolean(sc.target) && isClarify && namesTarget && !GENERIC_CLARIFY.test(message) && !WHICH_CARD.test(message);
  layers.target = !sc.target || targets.includes(sc.target) || confirmOk;
  if (confirmOk) notes.push("确认式澄清（点名了目标卡，属于正确确认，不是误问）");
  if (sc.target && !layers.target) notes.push(GENERIC_CLARIFY.test(message) ? "目标唯一但被追问，文案为通用兜底" : "未命中期望目标");

  const clarify = clarifyLayer({ clarifyExpected, isClarify, createdCount: created.length,
    notes: row.expected?.notes ?? row.notes ?? "", response: j });
  layers.clarify = clarify.ok;
  if (clarify.productChange) notes.push("产品变化：两个子动作已在一次提交里完成（按 notes 不算失败）");
  if (!clarifyExpected && isClarify) notes.push("非期望澄清：该条原文预期直接执行");

  const first = (spoken || message || "").trim();
  const firstLen = [...first].length;
  const firstPresent = firstLen > 0;
  const terminal = /已创建|已保存|已完成|成功创建|搞定啦|已经给你/.test(first);
  const firstValid = firstPresent && firstLen <= 80 && !terminal && !CONTRACT_WORDS.test(first) && !/^\s*[{[]/.test(first);
  layers.firstSentence = firstValid;
  const jsonLike = /^\s*[{[]/.test(message) || /"[A-Za-z_]+"\s*:/.test(message) || CONTRACT_WORDS.test(message)
    || /\{"|"[A-Za-z_]+":/.test(spoken);
  layers.noJson = !jsonLike;

  const failed = Object.entries(layers).filter(([, ok]) => !ok).map(([k]) => k);
  const coreFailed = failed.filter(k => k !== "firstSentence");
  const verdict = row.error ? "fail-transport" : coreFailed.length === 0
    ? (clarify.productChange ? "pass-product-change" : clarifyExpected ? "pass-clarify" : (isClarify && confirmOk) ? "pass-confirm" : firstValid ? "pass" : "pass-core")
    : `fail-${coreFailed.join("+")}`;
  return { kind, route: tracedRoute ?? hostRoute, clauseRoutes, gotRoutes, createdTypes: createdSet, targetIds: [...new Set(targets)],
    isClarify, confirmOk, message, spoken, firstSentence: first, firstLen, firstPresent, firstValid, terminalWording: terminal,
    productChange: clarify.productChange, cardRule: cards.rule,
    plannerCalls: trace?.plannerCalls ?? null, directClauses: trace?.directClauses ?? null, mode: trace?.mode ?? null,
    traceStatus: trace?.status ?? null, taskDecision: j.task?.decision ?? null, usedProvider: j.usedProvider ?? null,
    sources: (trace?.decisions ?? []).map(d => d.source ?? null), layers, failed, verdict, notes,
    cardProps: actions.filter(a => a.type === "card.create").map(a => ({ type: a.card?.type, props: a.card?.displayProps })) };
}
