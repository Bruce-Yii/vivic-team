// accept60 判分口径（唯一实现）。
//
// 线上跑批 accept60.mjs 与离线重算 recompute-*.mjs 都调用这里的 evaluate()，
// 避免"跑批一套口径、报告另一套口径"。
//
// 口径来源：work/scenarios/scenarios-20261031.json 的每条 notes。
//  1) expected_card_types 是"任一合格"而不是集合全等 —— sc-18 的 notes 写明
//     "TableCard 与 ComparisonCard 任一合格"，旧口径却要求两者全等，把正确产物
//     判成 fail-cards（10-31、11-03 各记一次）。
//  2) notes 里写"若已支持一次提交，记录为产品变化而非失败"的用例（sc-47），
//     当响应确实一次性完成两个子动作（一个画布动作 + 一个宿主操作）时，clarify
//     层判过，并在报告里单独标 productChange，不混进 fail。
//  3) 没有期望卡型的用例仍然要求零卡（"做不到"和"别多建"都是硬要求）。
//  4) route 层只在响应里存在**可观测**路由信息时判分；没有 trace（旧版）或
//     trace 里 route/decisions 全为 null（分类器删除后的新版）都记 N/A。
//  5) 2026-11-05 产品变化（查询工具只读，决策见 docs/decisions/
//     2026-11-05-query-tools-are-read-only.md）：search / weather / read_url
//     只把已验证的事实回灌给模型一次，是否展示、如何回答由模型决定。
//     sc-19 / sc-20 / sc-21 因此在数据集里带 card_optional=true：只要答案对，
//     零卡也是 pass；真的出卡时，卡型仍必须落在 expected_card_types 里且带来源。
//     旧口径「查询必须落卡」作废，不因此在报告里记 fail-cards。

export const CLARIFY_EXPECTED = new Set(["sc-31", "sc-47", "sc-48", "sc-55", "sc-56", "sc-57", "sc-58", "sc-59", "sc-60"]);
// sc-49 left the clarify set on 2026-11-04: query + card may share a turn now; a partial
// result must be reported instead of the whole sentence being turned into a question.
// sc-52 left the clarify set on 2026-11-05: a decided action and a clarify may share one
// batch (the note is built and the missing countdown duration is asked in a subtitle). The
// old "whole-sentence question, zero cards" expectation is retired as a product change.

/** 查询工具只读后，这几条不再强制出卡；`card_optional` 是数据集里的事实来源。 */
export const QUERY_TOOLS_READ_ONLY = new Set(["sc-19", "sc-20", "sc-21"]);

const CONTRACT_WORDS = /\b(NoteCard|TodoCard|CountdownCard|WeatherCard|NewsCard|SearchResultCard|TableCard|ChartCard|WeeklyScheduleCard|ComparisonCard|ActionEnvelope|schemaVersion|card\.create|canvas\.fit)\b/;
/** AnswerCard 在卡契约里就是回答卡，旧数据集写作 NewsCard：同一张卡的两个名字。 */
const CARD_TYPE_ALIASES = { AnswerCard: "NewsCard" };

/** 期望卡型 = "任一合格"：实际产出的每一种卡都必须在期望集合里，且不能一张都没有。
 *  card_optional 允许一张都不建（sc-15「允许只回字幕」）；期望为空则不许建卡。 */
export function cardsLayer(expectedTypes, createdTypes, cardOptional = false) {
  const expected = [...new Set((expectedTypes ?? []).map(type => CARD_TYPE_ALIASES[type] ?? type))].sort();
  const created = [...new Set((createdTypes ?? []).map(type => CARD_TYPE_ALIASES[type] ?? type))].sort();
  if (!expected.length) return { ok: created.length === 0, rule: "none-expected" };
  if (!created.length) return { ok: cardOptional === true, rule: cardOptional === true ? "optional" : "any-of" };
  return { ok: created.every(type => expected.includes(type)), rule: "any-of" };
}

/** sc-47 这类用例的 notes 允许"一次提交"作为产品变化。 */
export const notesAllowSingleSubmission = notes => /若已支持一次提交/.test(notes ?? "");

/** 两个子动作在同一次提交里都做完了：有画布动作 + 有宿主操作。 */
export const completedSingleSubmission = response => {
  const actions = response?.envelope?.actions ?? [];
  return Boolean(response?.hostOperation) && actions.length > 0;
};

/** clarify 层：期望澄清时要澄清且零卡；notes 允许的单次提交按产品变化放过。 */
export function clarifyLayer({ clarifyExpected, isClarify, createdCount, notes, response }) {
  if (!clarifyExpected) return { ok: true, productChange: false };
  if (isClarify && createdCount === 0) return { ok: true, productChange: false };
  const productChange = notesAllowSingleSubmission(notes) && completedSingleSubmission(response);
  return { ok: productChange, productChange };
}

/** 一条用例的完整判定。`response` = { json, error, attempts }。 */
export function evaluate(sc, response) {
  const j = response.json ?? {};
  const trace = j.trace ?? null;
  const actions = j.envelope?.actions ?? [];
  const created = actions.filter(a => a.type === "card.create").map(a => a.card?.type).filter(Boolean);
  const targets = actions.filter(a => a.targetId).map(a => ({ type: a.type, targetId: a.targetId }));
  const decisionTargets = (trace?.decisions ?? []).map(d => d.target ?? null);
  const clauseRoutes = (trace?.decisions ?? []).map(d => d.route ?? null);
  const route = trace?.route ?? null;
  const kind = j.kind ?? null;
  const message = j.message ?? "";
  const spoken = j.envelope?.spokenText ?? "";
  const expected = sc.expected_route;
  const expectedCards = sc.expected_card_types ?? [];
  const clarifyOk = CLARIFY_EXPECTED.has(sc.id);
  const gotRoutes = clauseRoutes.length ? clauseRoutes : (route ? [route] : []);
  const layers = {};
  const notes = [];

  // 4B 决策路由自 2026-11-03 关闭：路由层只在"有可观测路由信息"时判分。
  //   - 旧版响应完全没有 trace；
  //   - 新版响应补回了 trace，但决策分类器已删，trace.route 恒 null、
  //     decisions 全部 route:null（backend-merge apps/local-api/src/decision/trace.ts）。
  // 两种都属于"路由不可观测"，记 N/A（true），只在报告里说明，不因此扣分；
  // 其余各层判定不受影响。
  const observedRoutes = [route, ...clauseRoutes].filter(value => value != null);
  const routeKnown = Boolean(trace) && observedRoutes.length > 0;
  if (!routeKnown) {
    layers.route = true;
  } else {
    layers.route = route === expected || (kind === expected) || (gotRoutes[0] === expected);
    if (sc.routes) layers.route = sc.routes.every((r, i) => gotRoutes[i] === r) || (gotRoutes.length === sc.routes.length && sc.routes.every(r => gotRoutes.includes(r)));
  }

  const cards = cardsLayer(expectedCards, created, sc.card_optional === true);
  // card_optional means "an answer or an append instead of a new card is fine",
  // not "a failed tool turn is fine": a clarify/failure response with zero cards
  // must not pass just because the case allowed zero new cards.
  const failedTurn = kind === "clarify" || /没有给出可执行的动作|请换一种说法|暂时不可用/.test(message);
  layers.cards = cards.ok && !(expectedCards.length && created.length === 0 && sc.card_optional === true && failedTurn);
  if (!cards.ok && expectedCards.length) {
    notes.push(created.length ? `卡型不在期望集合内：${created.join(",")}` : "该条必须建卡，实际零卡");
  }

  const targetIds = [...new Set([...targets.map(t => t.targetId), ...decisionTargets.map(d => d?.cardId ?? d?.id).filter(Boolean)])];
  layers.target = !sc.expected_target || targetIds.length === 0 ? true : targetIds.includes(sc.expected_target);

  const isClarify = kind === "clarify" || Boolean(j.task?.clarification);
  const clarify = clarifyLayer({ clarifyExpected: clarifyOk, isClarify, createdCount: created.length,
    notes: sc.notes, response: j });
  layers.clarify = clarify.ok;
  if (clarify.productChange) notes.push("产品变化：两个子动作已在一次提交里完成（按 notes 不算失败）");

  const first = (spoken || message || "").trim();
  const firstLen = [...first].length;
  const firstPresent = firstLen > 0;
  const firstValid = firstPresent && firstLen <= 80
    && !/已创建|已保存|已完成|成功创建|搞定啦/.test(first)
    && !CONTRACT_WORDS.test(first) && !/^\s*[{[]/.test(first);
  layers.firstSentence = firstValid;
  const jsonLeak = /^\s*[{[]/.test(message) || /"[A-Za-z]+"\s*:/.test(message) || CONTRACT_WORDS.test(message)
    || /\{"|\bnull\b|true|false/.test(spoken) && /[:{}]/.test(spoken);
  layers.noJson = !jsonLeak;

  const failed = Object.entries(layers).filter(([, ok]) => !ok).map(([k]) => k);
  const coreFailed = failed.filter(k => k !== "firstSentence");
  const verdict = response.error ? "fail-transport" : coreFailed.length === 0
    ? (clarify.productChange ? "pass-product-change" : clarifyOk ? "pass-clarify" : firstValid ? "pass" : "pass-core-firstSentence-missing")
    : `fail-${coreFailed.join("+")}`;
  return { kind, route, routeKnown, clauseRoutes, gotRoutes, createdTypes: [...new Set(created.map(type => CARD_TYPE_ALIASES[type] ?? type))].sort(),
    targetIds, isClarify, message, spoken,
    firstLen, firstPresent, firstValid, plannerCalls: trace?.plannerCalls ?? null, directClauses: trace?.directClauses ?? null,
    mode: trace?.mode ?? null, usedProvider: j.usedProvider ?? null,
    sources: (trace?.decisions ?? []).map(d => d.source ?? null), layers, failed, verdict, notes,
    productChange: clarify.productChange, cardRule: cards.rule,
    attempts: response.attempts ?? null,
    cardProps: actions.filter(a => a.type === "card.create").map(a => ({ type: a.card?.type, props: a.card?.displayProps })) };
}
