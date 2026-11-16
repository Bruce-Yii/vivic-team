import type { HostOperation } from "@vivic/contracts";
import { exactHostOperation } from "../decision/hostOperations.js";
import { normalizeSimpleCommand } from "./commandText.js";

/**
 * Pure canvas operations (撤销/重做/恢复视图/显示全部/自动整理画布) are decided by
 * the host alone. They run at the same layer as the literal rule fast path so a
 * whole-sentence command never pays for a model turn.
 *
 * The match is deliberately strict: only the *complete* sentence after
 * politeness/punctuation normalization counts. A negation ("不要撤销") or a
 * second action ("撤销然后整理画布") leaves extra words in the sentence, so it
 * fails the anchored match and goes back to the model instead of half-executing.
 *
 * 显示全部/恢复视图 stay in `rules.ts` because they are ActionEnvelope actions;
 * this module owns the host-operation half and reuses the closed-form table the
 * native-v2 task manager already trusts (`exactHostOperation`).
 */
const NEGATED = /不要|不用|别|无需|先别|暂不|取消|停止|如果|要是|是否|能否|怎么|如何|为什么|什么意思/u;
/** Two operations in one sentence: the anchored table cannot express them. */
const MULTI = /然后|接着|之后|并且|同时|顺便|再|，|,|；|;|、|。|！|!|？|\?/u;

const ARRANGE = /^(?:自动)?(?:整理|排列|排一下|理一下)(?:一下)?(?:画布|桌面|布局|卡片|所有卡片|全部卡片)?$/u;

const MESSAGES: Partial<Record<HostOperation["kind"], string>> = {
  "history.undo": "已撤销上一步",
  "history.redo": "已重做上一步",
  "canvas.arrange": "已自动整理画布",
  "canvas.organize.preview": "已打开整理预览",
};

export interface FastOperation {
  hostOperation: HostOperation;
  /** One honest, already-finished line: no model sentence is involved. */
  message: string;
}

export function fastHostOperation(rawText: string): FastOperation | null {
  const text = rawText.trim();
  // Long sentences are never a pure command; 40 characters covers every
  // polite variant without giving the model's jobs to a substring match.
  if (!text || text.length > 40) return null;
  const simple = normalizeSimpleCommand(text);
  if (!simple || NEGATED.test(simple) || MULTI.test(simple)) return null;
  const hostOperation = exactHostOperation(simple) ?? (ARRANGE.test(simple) ? { kind: "canvas.arrange" as const } : null);
  if (!hostOperation) return null;
  return { hostOperation, message: MESSAGES[hostOperation.kind] ?? "已执行" };
}
