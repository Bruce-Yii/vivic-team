import type { IntentResult } from "../intent/pipeline.js";

/**
 * Decision authority: who is allowed to end a turn with a question.
 *
 * The model owns the decision (which capability, which target, what to ask).
 * The host only derives facts, validates a proposed plan and executes it. A
 * host module that wants to answer the user instead of the model must say *why*
 * it is entitled to — and that "why" is a closed set below. Everything else is
 * either
 *
 *   - the model's own decision (`source: "model"`, e.g. the `clarify` tool), or
 *   - a validation failure: the plan goes back to the model as `invalid` plus
 *     `issues` through the existing repair turn.
 *
 * This module exists so the boundary is a type + one checker instead of a habit.
 * `tests/layer-authority.test.ts` holds the static and behavioural guarantees.
 */

/** Why a host-side module may speak to the user instead of handing back a plan. */
export const HOST_INTERRUPT_REASONS = ["confirm", "safety", "policy", "vendor-unavailable"] as const;
export type HostInterruptReason = (typeof HOST_INTERRUPT_REASONS)[number];

/** Every reason is non-semantic: none of them is a judgement about what the
 *  sentence means or about which card/tool the user wanted. */
export const HOST_INTERRUPT_WHY: Readonly<Record<HostInterruptReason, string>> = Object.freeze({
  confirm: "破坏性/不可逆操作需要用户显式确认；宿主只冻结提案，不替用户点头。",
  safety: "宿主掌握的数据完整性边界（画布被截断、摘要字段缺失）；继续执行会写错卡。",
  policy: "传输/隐私策略拒绝（非公网 HTTPS、内网地址、控制字符）；与语义理解无关。",
  "vendor-unavailable": "上游能力不可用（没有模型可调用、修复轮后仍无可用计划、适配器无法解析）；必须给用户一句可见的话，不能空响应。",
});

/** Where a spoken question came from. `adapter` never reaches the user while a
 *  model is available: the pipeline turns it into `invalid` + issues first. */
export type DecisionSource = "model" | "host" | "adapter";

type InterruptExtra = Pick<IntentResult, "usedProvider" | "suggestions" | "toolCalls">;

/** The only way host code may build a user-facing clarification. */
export const hostInterrupt = (reason: HostInterruptReason, message: string, extra: InterruptExtra = {}): IntentResult => ({
  kind: "clarify",
  message,
  source: "host",
  interrupt: { reason },
  ...extra,
});

/** A question the *model* decided to ask (the `clarify` tool). */
export const modelClarify = (message: string, extra: InterruptExtra = {}): IntentResult => ({
  kind: "clarify",
  message,
  source: "model",
  ...extra,
});

/** An adapter's own refusal. Internal only: the pipeline either hands it back to
 *  the model as a validation issue or, with no model at all, re-tags it as
 *  `vendor-unavailable` before it can reach the user. */
export const adapterClarify = (message: string, extra: InterruptExtra = {}): IntentResult => ({
  kind: "clarify",
  message,
  source: "adapter",
  ...extra,
});

export type AuthorityView = Pick<IntentResult, "kind" | "source" | "interrupt">;

/** `null` when the result respects the boundary; otherwise what is wrong. */
export const decisionAuthorityIssue = (result: AuthorityView): string | null => {
  if (result.kind !== "clarify") return null;
  if (result.source === "model") return null;
  const reason = result.interrupt?.reason;
  if (!reason) {
    return "宿主澄清缺少 interrupt.reason：只允许 confirm / safety / policy / vendor-unavailable；"
      + "其余情况必须回传 invalid+issues（修复轮）或由模型自己 clarify";
  }
  if (!(HOST_INTERRUPT_REASONS as readonly string[]).includes(reason)) return `未知的 interrupt.reason「${String(reason)}」`;
  return null;
};
