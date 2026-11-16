import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ROUTES } from "@vivic/contracts";
import type { IntentRequest, IntentResult, PipelineDeps } from "../intent/pipeline.js";
import { splitClauses } from "./split.js";

/** Clause → contract → card ids. Answers "which clause produced what" without
 * granting anything: a plan only proves provenance after the host commits it. */
export interface ClausePlan { clause: number; contract: string; cardIds: string[]; source: "rules" | "planner" }
/** Cards actually built per clause. Types and counts only: never titles or text. */
export interface ClauseBuild { clause: number; cards: string[]; n: number }

const route = z.union([z.enum(Object.keys(ROUTES) as [keyof typeof ROUTES, ...Array<keyof typeof ROUTES>]),
  z.string().max(90).regex(/^ext\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/)]);
/** Why a target was chosen; optional for older traces and callers. */
const targetSource = z.enum(["title", "alias", "focus", "ordinal", "type", "spatial", "classifier", "frozen", "user_pick", "missing", "ambiguous"]);
const target = z.union([z.strictObject({ targetId: z.string().max(128), source: targetSource.optional() }),
  z.strictObject({ missing: z.literal(true), source: targetSource.optional() }), z.strictObject({ ambiguous: z.array(z.strictObject({
    id: z.string().max(128), label: z.string().max(500),
  })).max(40), source: targetSource.optional() })]);
const built = z.strictObject({ cards: z.array(z.string().max(80)).max(12), n: z.int().min(0).max(12) });
/** One clause row. The classifier that used to fill `route`, `probability` and
 * `source: "decision"` is gone; stored rows from before that deletion still parse. */
const decision = z.strictObject({ text: z.string().max(500), route: route.nullable(),
  probability: z.number().min(0).max(1), probabilities: z.record(z.string(), z.number().min(0).max(1)),
  none: z.boolean(), latencyMs: z.number().nonnegative(), failed: z.boolean(), target: target.optional(),
  built: built.optional(), source: z.enum(["rules", "decision"]).optional(),
  routeSource: z.enum(["rules", "model", "skipped", "planner"]).optional() });
const plan = z.strictObject({ clause: z.int().min(0).max(2), contract: z.string().min(1).max(100),
  cardIds: z.array(z.string().max(128)).max(12), source: z.enum(["rules", "planner"]) });
/** Turn provenance: what the host committed per clause, without any classifier
 * comparison. Fields the classifier used to fill are optional and are not
 * produced any more, so old rows stay readable. */
export const DecisionTraceSchema = z.strictObject({
  id: z.string().max(128),
  mode: z.enum(["shadow", "on"]).optional(), status: z.enum(["pending", "complete", "failed"]),
  taskId: z.string().max(128).optional(),
  /** HTTP/task request id, so container logs and decision_log can be joined to trace.id. */
  requestId: z.string().max(128).optional(),
  clauses: z.array(z.string().max(500)).max(3).default([]), decisions: z.array(decision).max(3).default([]),
  route: route.nullable().default(null), probability: z.number().min(0).max(1).default(0), target: target.optional(),
  latencyMs: z.number().nonnegative().default(0), routeLatencyMs: z.number().nonnegative().default(0),
  legacyElapsedMs: z.number().nonnegative().default(0), shadowWaitMs: z.number().nonnegative().default(0),
  failedCount: z.int().min(0).max(3).default(0), legacyKind: z.string().max(32),
  /** Provider that produced the authoritative result: rules, stepfun,
   * deepseek, gpt, rules-offline, search or decision. A bounded string keeps
   * traces written before the deepseek label readable. */
  legacyUsedProvider: z.string().max(32).optional(), legacyActionTypes: z.array(z.string().max(80)).max(32).default([]),
  legacyCardTypes: z.array(z.string().max(80)).max(32).default([]),
  plannerCalls: z.int().min(0).max(100).optional(),
  directClauses: z.int().min(0).max(3).optional(),
  /** Only stored rows from before `VIVIC_DECISION_POLICY` was deleted carry this. */
  policy: z.enum(["full", "main-only"]).optional(),
  /** First published feedback sentence, in ms from the planner stage start. Absent when none was sent. */
  firstFeedbackMs: z.number().nonnegative().optional(),
  /** Backward-compatible: absent unless this turn committed an envelope. */
  plans: z.array(plan).max(12).optional(),
});
export type DecisionTrace = z.infer<typeof DecisionTraceSchema>;

/**
 * Records one turn's provenance for the private decision log.
 *
 * It does not route, classify, wait, or publish a hint: it observes the result
 * the host already produced. Receipts and cancellations are not new proposals
 * and are never traced; when nothing listens (the local app) it is a
 * pass-through.
 */
export async function observeDecision(req: IntentRequest, deps: PipelineDeps, _signal: AbortSignal | undefined,
  legacy: () => Promise<IntentResult>): Promise<IntentResult> {
  if (!deps.onDecisionTrace || req.task?.receipt || req.task?.cancel) return legacy();
  const start = performance.now(), id = `decision_${randomUUID()}`;
  const result = await legacy();
  const elapsedMs = Math.round(performance.now() - start);
  const actions = result.envelope?.actions ?? [];
  // Provenance is only truthful for a committed proposal: drop plans whose
  // cards did not reach the returned envelope.
  const created = new Set(actions.flatMap(action => action.type === "card.create" ? [action.card.id] : []));
  const seenPlans = new Set<string>();
  const plans = result.envelope ? deps.decisionTelemetry?.plans
    ?.filter(entry => entry.cardIds.every(cardId => created.has(cardId)))
    .filter(entry => {
      const key = `${entry.source}\u0000${entry.clause}\u0000${entry.contract}\u0000${entry.cardIds.join(",")}`;
      if (seenPlans.has(key)) return false;
      seenPlans.add(key);
      return true;
    })
    .sort((a, b) => a.clause - b.clause) : undefined;
  const builds = new Map((deps.decisionTelemetry?.built ?? []).map(entry => [entry.clause, entry]));
  const clauses = splitClauses(req.text);
  const decisions = [...builds.entries()].sort((a, b) => a[0] - b[0]).map(([clause, entry]) => ({
    text: clauses[clause] ?? "", route: null, probability: 0, probabilities: {}, none: true, latencyMs: 0,
    failed: false, built: { cards: entry.cards, n: entry.n },
  }));
  const returned: DecisionTrace = {
    id, status: "complete",
    ...(req.task?.id ? { taskId: req.task.id } : {}),
    ...(req.requestId ? { requestId: req.requestId } : {}),
    clauses, decisions, route: null, probability: 0,
    latencyMs: elapsedMs, routeLatencyMs: 0, legacyElapsedMs: elapsedMs, shadowWaitMs: 0, failedCount: 0,
    legacyKind: result.kind,
    ...(result.usedProvider ? { legacyUsedProvider: result.usedProvider } : {}),
    legacyActionTypes: [...actions.map(action => action.type), ...(result.hostOperation ? [result.hostOperation.kind] : [])],
    legacyCardTypes: actions.flatMap(action => action.type === "card.create" ? [action.card.type] : []),
    ...(deps.decisionTelemetry ? { plannerCalls: deps.decisionTelemetry.plannerCalls, directClauses: deps.decisionTelemetry.directClauses } : {}),
    ...(deps.decisionTelemetry?.firstFeedbackMs !== undefined ? { firstFeedbackMs: deps.decisionTelemetry.firstFeedbackMs } : {}),
    ...(plans?.length ? { plans } : {}),
  };
  const valid = DecisionTraceSchema.safeParse(returned);
  if (valid.success) {
    setImmediate(() => {
      try { void Promise.resolve(deps.onDecisionTrace?.(req, valid.data, result)).catch(() => {}); }
      catch { /* observer failure is noncritical */ }
    });
    return { ...result, trace: valid.data };
  }
  return result;
}
