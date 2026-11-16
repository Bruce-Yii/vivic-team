import { randomUUID } from "node:crypto";
import { startsNewInstruction } from "@vivic/contracts";
import { ActionEnvelopeSchema, type DecisionTaskStatus } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";
import type { IntentRequest, IntentResult } from "../intent/pipeline.js";
import { createBudget } from "../intent/budget.js";
import { confirmsDeletion, deletionLabel, deletionStillCurrent, deletionTargets, freezeDeletion, numberedCandidates, numberedChoiceQuestion,
  publicIntentResult, selectedCandidate, type DeleteConfirmation } from "./confirmation.js";
import { splitClauses } from "./split.js";
import { assessDeletion, deicticDeletion, retargetDeletion } from "./deleteTarget.js";
import { isNewCommand } from "./continuation.js";

/**
 * Flow state around the one model decision path.
 *
 * This manager owns only the task lifecycle: creation, cross-request
 * continuation (clarification and confirmation answers), destructive-operation
 * freezing, execution receipts, idempotency and cancellation. It never chooses
 * the next step, never asks a native choice model, and never derives an
 * operation itself: every plan comes from `deps.legacy`, which is the same
 * model + tools pipeline a plain request uses.
 *
 * The wire keeps `protocolVersion`/`decision` for older clients; `native-v2`
 * is never produced any more (see docs/decisions/2026-11-04-remove-native-task-decider.md).
 */

type Observation = { kind: "llm" | "tool" | "execution" | "error"; status: "succeeded" | "failed"; executionId?: string; result?: unknown };
type Clarification = NonNullable<DecisionTaskStatus["clarification"]>;
interface Task {
  id: string; originalGoal: string; input: string; canvasId: string; step: number;
  createdAt: number; activeMs: number; controller: AbortController; busy?: Promise<IntentResult>;
  result?: IntentResult; status: DecisionTaskStatus["status"];
  context: CanvasContext; observations: Observation[]; completed: string[];
  clarification?: Clarification; pendingExecution?: IntentResult;
  receipts: Map<string, IntentResult>;
  safetyMode?: boolean; deleteConfirmation?: DeleteConfirmation; resolvedTargetId?: string;
  resolvedTargets: Record<string, string>; targetClause?: number;
}
export interface TaskRunDeps {
  /** The only planning path: the same `runIntent` (model + tools) a plain turn uses. */
  legacy: (request: IntentRequest, signal: AbortSignal) => Promise<IntentResult>;
  isCurrent?: () => boolean;
  /** Enabled by the host for decision mode on; retained for this task's lifetime. */
  safetyMode?: boolean;
  /** Semantic confirmation; absent falls back to the deterministic grammar. */
  classifyConfirmation?: (question: string, reply: string, signal?: AbortSignal) => Promise<"confirm" | "cancel" | "unclear" | undefined>;
}
interface Options { now?: () => number; maxActiveMs?: number; ttlMs?: number; maxTasks?: number }

/** Session-owned bounded state. A returned proposal is not a completed operation. */
const TALKS_ABOUT_DELETION = /确定|确认|删|先|然后|再|但|不|别|取消|算了|撤销/u;
function abandonsPending(task: Task, text: string): boolean {
  const value = text.trim();
  // Anything that talks about the deletion itself, or is a correction/sequence,
  // keeps the old "cancel, execute nothing" safety answer.
  if (task.deleteConfirmation)
    return !confirmsDeletion(value) && !TALKS_ABOUT_DELETION.test(value) && startsNewInstruction(value);
  if (task.clarification?.candidates.length && selectedCandidate(value, task.clarification.candidates)) return false;
  // The shared grammar understands greetings and a few legacy phrasings; the
  // continuation classifier is the wider gate ("把刚才那张卡往右移一点").
  return isNewCommand(value, { question: task.clarification?.question, previousUtterance: task.originalGoal })
    || startsNewInstruction(value, task.originalGoal);
}

const PLANNER_TYPE_WORDS: Array<[RegExp, RegExp]> = [[/待办|清单/u, /^TodoCard$/], [/便笺|便签|笔记/u, /^NoteCard$/],
  [/倒计时|计时/u, /^CountdownCard$/], [/对比|比较/u, /^ComparisonCard$/], [/日程|计划|安排/u, /^Schedule|Agenda|Timeline/]];
const rowLabel = (card: CanvasContext["cards"][number]) => String(card.displayProps.title ?? card.displayProps.text ?? card.aliases?.[0] ?? card.sourceDataSummary.reminderText ?? card.type).slice(0, 100);

export class DecisionTaskManager {
  private readonly tasks = new Map<string, Task>();
  private readonly options: Options;
  constructor(options: Options = {}) { this.options = options; }
  dispose() { for (const task of this.tasks.values()) task.controller.abort(); this.tasks.clear(); }
  private now() { return this.options.now?.() ?? Date.now(); }
  private meta(task: Task): DecisionTaskStatus {
    return { protocolVersion: "vivic-decision-v2", id: task.id, step: task.step, status: task.status,
      // Compatibility label only: the native decision loop is gone, every task
      // is planned by the model. Older clients still parse these two fields.
      decision: "legacy-fallback",
      ...(task.context.version === undefined ? {} : { canvasVersion: task.context.version }),
      ...(task.pendingExecution?.task?.executionId ? { executionId: task.pendingExecution.task.executionId } : {}),
      ...(task.clarification ? { clarification: { question: task.clarification.question,
        candidates: task.clarification.candidates.map(candidate => ({ ...candidate })) } } : {}) };
  }
  private result(task: Task, result: IntentResult): IntentResult { task.result = { ...publicIntentResult(result), task: this.meta(task) }; return task.result; }
  private terminal(task: Task, status: "completed" | "cancelled" | "failed", message: string): IntentResult {
    task.status = status; task.pendingExecution = undefined; task.clarification = undefined; task.deleteConfirmation = undefined;
    return this.result(task, { kind: status === "failed" ? "error" : "task", message });
  }
  private clarify(task: Task, message: string, candidates: Clarification["candidates"] = []): IntentResult {
    task.status = "awaiting_clarification"; task.clarification = { question: message.slice(0, 180), candidates };
    return this.result(task, { kind: "clarify", message });
  }
  private plannerClarification(task: Task, result: IntentResult): IntentResult {
    let candidates = numberedCandidates(result.targetCandidates ?? [], task.context);
    const clause = result.targetClause;
    task.targetClause = typeof clause === "number" && Number.isInteger(clause) && clause >= 0 && clause <= 2 ? clause : undefined;
    // A planner "which card?" without choices made the user's "第二张" a brand-new
    // request. Attach the named type's cards as numbered, selectable choices.
    if (!candidates.length && /哪一?[张个份条]|哪张|哪个/u.test(result.message ?? "")) {
      const type = PLANNER_TYPE_WORDS.find(([words]) => words.test(task.originalGoal))?.[1];
      const pool = type ? task.context.cards.filter(card => type.test(card.type)) : [];
      if (pool.length >= 2) {
        const seen = new Map<string, number>();
        const choice = numberedChoiceQuestion(`${(result.message ?? "要操作哪一张？").replace(/[。？?]*$/u, "")}？`, [...pool].reverse().map((card, index) => {
          const base = rowLabel(card).slice(0, 24), n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
          return { number: index + 1, id: card.id, label: n > 1 ? `${base}（第${n}张）` : base };
        }));
        candidates = choice.candidates;
        this.clarify(task, choice.message, candidates);
        return this.result(task, { ...result, message: choice.message });
      }
    }
    this.clarify(task, result.message ?? "请补充必要信息。", candidates);
    return this.result(task, result);
  }
  private async execute(task: Task, proposal: IntentResult, confirmed = false): Promise<IntentResult> {
    if (!proposal.envelope && !proposal.hostOperation) throw new Error("invalid_execution");
    if (task.safetyMode && !confirmed && deletionTargets(proposal).length) {
      // A composite delete must not smuggle its second operation through a
      // confirmation question that only mentions the deletion.
      if (proposal.hostOperation) return this.clarify(task, "这条指令包含删除和其他操作，请先单独发送删除；本次未执行任何操作。");
      // The user's rule: a delete whose target the sentence already pins down
      // (id, unique title/content, the focus it points at) runs once. Only an
      // ambiguous, multi-card or mismatched target is asked about.
      let effective = proposal;
      const verdict = await assessDeletion(effective, task.context, task.originalGoal);
      // A pure pointer ("删了它") names exactly one card; when the proposal landed
      // elsewhere the host moves the single delete onto that card.
      if (verdict && verdict.mode !== "refuse" && verdict.targetId && verdict.targetId !== deletionTargets(effective)[0])
        effective = retargetDeletion(effective, verdict.targetId);
      if (verdict?.mode === "refuse") return this.clarify(task, verdict.message);
      if (!verdict || verdict.mode === "confirm") {
        const confirmation = freezeDeletion(effective, task.context);
        if (!confirmation) return this.clarify(task, "删除目标或画布范围已失效，请重新发送；本次未执行任何操作。");
        task.deleteConfirmation = confirmation;
        return this.clarify(task, confirmation.question);
      }
      proposal = effective;
    }
    task.status = "awaiting_execution"; task.clarification = undefined;
    const executionId = `exec_${randomUUID()}`;
    const result = { ...publicIntentResult(proposal), task: { ...this.meta(task), executionId } };
    task.pendingExecution = result; task.result = result;
    return result;
  }
  async run(request: IntentRequest, deps: TaskRunDeps, signal?: AbortSignal): Promise<IntentResult> {
    const id = request.task?.id ?? `task_${randomUUID()}`;
    let task = this.tasks.get(id);
    if (task && task.canvasId !== request.canvasContext.canvasId) return { kind: "error", message: "任务所属画布已变更，请重新发送。" };
    if (task && this.now() - task.createdAt > (this.options.ttlMs ?? 10 * 60_000)) { task.controller.abort(); return this.terminal(task, "failed", "任务已过期，请重新发送。" ); }
    // A fresh command spoken while a question is pending must run, not be
    // swallowed as a bad answer ("删除已取消" / "请用原候选的编号…"). The old
    // question is closed as cancelled so no dangling clarification survives.
    if (task && !task.busy && task.status === "awaiting_clarification" && !request.task?.receipt && !request.task?.cancel
      && request.text !== task.input && abandonsPending(task, request.text)) {
      this.terminal(task, "cancelled", "已放弃上一个问题，按新指令处理。");
      task.controller.abort(); this.tasks.delete(id); task = undefined;
      request = { ...request, continuation: undefined };
    }
    if (request.task?.cancel) {
      if (!task) return { kind: "error", message: "任务已结束或不存在。" };
      task.controller.abort(); return this.terminal(task, "cancelled", "已取消尚未执行的步骤。" );
    }
    if (!task) {
      if (request.task?.receipt) return { kind: "error", message: "任务已结束或服务已重启，不能重放旧执行结果。" };
      // Bound memory without turning a long acceptance run into a hard outage:
      // 1) drop expired tasks; 2) if still full, evict oldest terminal tasks;
      // only then refuse. Default is high enough for hundreds of taskless turns.
      const maxTasks = Math.max(16, this.options.maxTasks ?? 512);
      if (this.tasks.size >= maxTasks) {
        const ttl = this.options.ttlMs ?? 10 * 60_000;
        for (const [key, old] of this.tasks) if (this.now() - old.createdAt > ttl) { old.controller.abort(); this.tasks.delete(key); }
        if (this.tasks.size >= maxTasks) {
          // Never turn "a long acceptance run" into a hard outage: evict the
          // oldest idle task (any status) before refusing a new one.
          const idle = [...this.tasks.entries()]
            .filter(([, old]) => !old.busy)
            .sort((a, b) => a[1].createdAt - b[1].createdAt);
          while (this.tasks.size >= maxTasks && idle.length) this.tasks.delete(idle.shift()![0]);
        }
        if (this.tasks.size >= maxTasks) return { kind: "error", message: "会话任务较多，请稍后重试。" };
      }
      task = { id, originalGoal: request.text, input: request.text, canvasId: request.canvasContext.canvasId, step: 0,
        createdAt: this.now(), activeMs: 0, controller: new AbortController(), status: "awaiting_clarification",
        context: request.canvasContext, observations: [], completed: [], receipts: new Map(),
        safetyMode: deps.safetyMode === true, resolvedTargets: {} };
      this.tasks.set(id, task);
    } else {
      if (task.busy) return task.busy;
      if (["completed", "failed", "cancelled"].includes(task.status)) return task.result!;
      if (deps.safetyMode) task.safetyMode = true;
      const receipt = request.task?.receipt;
      if (receipt && task.receipts.has(receipt.executionId)) return task.receipts.get(receipt.executionId)!;
      if (task.pendingExecution) {
        if (!receipt) return task.pendingExecution;
        if (receipt.executionId !== task.pendingExecution.task?.executionId) return { kind: "error", message: "执行回执不属于当前步骤，已拒绝。", task: this.meta(task) };
        if (request.canvasContext.version !== undefined && task.context.version !== undefined && request.canvasContext.version < task.context.version)
          return { kind: "error", message: "执行回执的画布版本已过期，请刷新状态后继续。", task: this.meta(task) };
        const expected = task.pendingExecution.envelope?.actions.flatMap(action => action.type === "card.create" ? [action.card.id] : []) ?? [];
        if (receipt.status === "succeeded" && expected.some(cardId => !receipt.createdCardIds?.includes(cardId) || !request.canvasContext.cards.some(card => card.id === cardId)))
          return { kind: "error", message: "新卡片尚未在执行回执和画布中确认，请刷新状态后继续。", task: this.meta(task) };
        const executed = task.pendingExecution.hostOperation ?? { actions: task.pendingExecution.envelope?.actions.map(action => action.type === "card.create"
          ? { type: action.type, card_id: action.card.id, card_type: action.card.type } : action) };
        task.observations.push({ kind: "execution", status: receipt.status, executionId: receipt.executionId, result: receipt.status === "succeeded"
          ? { operation: executed, created_card_ids: expected } : { operation: executed, error: receipt.error ?? "执行器拒绝" } });
        task.pendingExecution = undefined; task.context = request.canvasContext;
        if (receipt.status === "failed") { const result = this.terminal(task, "failed", `操作未完成：${receipt.error ?? "执行器拒绝"}`.slice(0, 400)); task.receipts.set(receipt.executionId, result); return result; }
        // The model path plans one bounded turn per request. Once its proposal
        // has a real succeeded receipt the task is complete; another request
        // starts a new task instead of making the host invent the next step.
        task.completed.push("validated_plan");
        const result = this.terminal(task, "completed", "已完成。" );
        task.receipts.set(receipt.executionId, result);
        return result;
      } else if (receipt) return { kind: "error", message: "当前任务没有等待此执行回执。", task: this.meta(task) };
      else if (task.result && task.status === "awaiting_clarification") {
        if (request.text === task.input) return task.result;
        if (task.deleteConfirmation) {
          const confirmation = task.deleteConfirmation;
          task.context = request.canvasContext;
          if (signal?.aborted || task.controller.signal.aborted) return this.terminal(task, "cancelled", "删除已取消，未执行任何操作。");
          if (deps.isCurrent && !deps.isCurrent()) return this.terminal(task, "failed", "模型连接已变更，删除已取消。");
          if (task.activeMs >= (this.options.maxActiveMs ?? 90_000)) return this.terminal(task, "failed", "任务处理超时，删除已取消。");
          // Ask the model what the reply means; only an explicit "confirm" unlocks
          // execution. Deterministic grammar is the offline fallback.
          const decision = deps.classifyConfirmation
            ? await deps.classifyConfirmation(confirmation.question, request.text, signal)
            : undefined;
          if (signal?.aborted || task.controller.signal.aborted) return this.terminal(task, "cancelled", "删除已取消，未执行任何操作。");
          if (decision === "cancel") return this.terminal(task, "cancelled", "删除已取消，未执行任何操作。");
          if (decision === "unclear") return this.clarify(task, confirmation.question);
          if (decision === undefined && !confirmsDeletion(request.text)) return this.terminal(task, "cancelled", "删除已取消，未执行任何操作。");
          if (!deletionStillCurrent(confirmation, task.context)) return this.terminal(task, "cancelled", "画布或删除目标已变更，请重新发起并确认；本次未执行任何操作。");
          task.deleteConfirmation = undefined;
          return this.execute(task, confirmation.proposal, true);
        }
        if (task.context.version !== undefined && request.canvasContext.version !== undefined && request.canvasContext.version < task.context.version)
          return this.clarify(task, "画布版本已过期，请刷新后按原候选重新选择。", task.clarification?.candidates);
        task.input = request.text; task.context = request.canvasContext;
        // Ordinal answers address the exact frozen question, independent of today's canvas ordering.
        if (task.clarification?.candidates.length) {
          if (/^(?:取消|算了|算了不要了|不选了)[。！!]?$/u.test(request.text.trim())) return this.terminal(task, "cancelled", "已取消尚未执行的操作。");
          const selected = selectedCandidate(request.text, task.clarification.candidates);
          if (!selected) return this.clarify(task, "请用原候选的编号或完整标题选择。", task.clarification.candidates);
          if (task.context.cards.filter(card => card.id === selected.id).length !== 1) return this.clarify(task, "这个候选已不存在，请重新选择。", task.clarification.candidates);
          task.resolvedTargets[String(task.targetClause ?? 0)] = selected.id;
          task.resolvedTargetId = splitClauses(task.originalGoal).length === 1 ? selected.id : undefined;
          task.input = task.originalGoal;
        }
      } else if (task.result) return task.result;
    }
    const activeTask = task;
    const run = this.advance(activeTask, request, deps, signal);
    activeTask.busy = run;
    try {
      const result = await run;
      if (request.task?.receipt) activeTask.receipts.set(request.task.receipt.executionId, result);
      return result;
    } finally { activeTask.busy = undefined; }
  }
  private async advance(task: Task, request: IntentRequest, deps: TaskRunDeps, signal?: AbortSignal): Promise<IntentResult> {
    const remaining = (this.options.maxActiveMs ?? 90_000) - task.activeMs;
    if (remaining <= 0) return this.terminal(task, "failed", "任务处理超时，已停止后续操作。" );
    // Pure pointer deletes ("删了它", "删掉刚才那个", "删了") are host-decidable:
    // the referent is the last focused card. Resolving it here means no model
    // turn can turn a clear "它" into "which card?" or into a stale id.
    if (task.safetyMode && !task.completed.length && task.input === task.originalGoal
      && !request.continuation && !request.attachments?.length && splitClauses(task.originalGoal).length === 1) {
      const deictic = deicticDeletion(task.originalGoal, task.context);
      if (deictic) {
        if ("message" in deictic) return this.clarify(task, deictic.message);
        const card = task.context.cards.find(value => value.id === deictic.targetId);
        if (!card) return this.clarify(task, "刚才聚焦的卡片已经不在画布上，本次没有删除。请直接说要删除的卡片名称。");
        return this.execute(task, { kind: "envelope", usedProvider: "rules", envelope: ActionEnvelopeSchema.parse({
          schemaVersion: "0.6", requestId: `deictic_${randomUUID()}`, canvasId: task.canvasId,
          spokenText: `已删除「${deletionLabel(card)}」，可撤销。`,
          actions: [{ type: "card.delete", targetId: card.id }],
        }) });
      }
    }
    const budget = createBudget(remaining, [signal, task.controller.signal]), start = this.now();
    const check = () => { budget.signal.throwIfAborted(); if (deps.isCurrent && !deps.isCurrent()) throw new Error("connection_changed"); };
    try {
      check();
      task.step++;
      const plan = await budget.run(() => deps.legacy({ ...request, text: task.originalGoal, task: undefined,
        canvasContext: task.context,
        // The closed-form rules may answer an offline reference only on the
        // first turn; a follow-up answer needs the model.
        offlineReferenceCompatibility: !task.completed.length,
        ...(task.input !== task.originalGoal && !Object.keys(task.resolvedTargets).length ? { text: task.input, continuation: { utterance: task.originalGoal, question: task.clarification?.question ?? "请补充必要信息" } } : {}),
        ...(Object.keys(task.resolvedTargets).length ? { resolvedTargets: { ...task.resolvedTargets }, continuation: undefined } : {}),
        ...(task.resolvedTargetId ? { resolvedTargetId: task.resolvedTargetId, continuation: undefined } : {}),
        taskContext: { original_goal: task.originalGoal, completed_steps: task.completed, observations: task.observations, instruction: "只完成尚未执行的目标，不得重复已成功步骤。" } }, budget.signal));
      check();
      if (plan.envelope || plan.hostOperation) return this.execute(task, plan);
      if (plan.kind === "clarify") return this.plannerClarification(task, plan);
      task.status = plan.kind === "locale" ? "completed" : "failed";
      return this.result(task, plan);
    } catch {
      if (budget.signal.aborted || task.controller.signal.aborted) return this.terminal(task, task.controller.signal.aborted || signal?.aborted ? "cancelled" : "failed", "请求已取消或超时，后续操作已停止。" );
      return this.terminal(task, "failed", "任务预算、连接或状态校验未通过，已停止后续操作。" );
    } finally { task.activeMs += this.now() - start; budget.dispose(); }
  }
}
