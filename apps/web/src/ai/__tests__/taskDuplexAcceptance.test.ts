import { afterEach, describe, expect, it } from "vitest";
import { applyInterjection, decideInterjection, type InterjectionEffects } from "../interjection";
import {
  inferTaskMutationClass,
  isStaleProjection,
  projectDecisionTask,
  type DecisionTaskStatusLike,
  type TaskProjection,
} from "../taskProjection";
import {
  appendWorkingConstraint,
  classifyIntent,
  classifyTaskCancellationSafety,
  clearWorkingConstraints,
  consumeWorkingConstraints,
  getWorkingConstraints,
  type InterruptedSpeechContext,
} from "../turnTaking";

/**
 * C3 acceptance: a Hosted Task in flight is a duplex state, not fire-and-forget.
 *
 * These tests are the LOGIC layer: they feed the coordinator the same Host task
 * projection the real `/api/intent` response produces (`projectDecisionTask`),
 * then assert exactly what the coordinator would do — one cancel, one dispatch,
 * or one queued constraint — through the same policy + effect functions the
 * full-duplex listener uses (`decideInterjection` / `applyInterjection`).
 *
 * Real Host receipts (step / executionId / canvasVersion / clarification from
 * the live API) are exercised separately by `work/asr-corpus/c3-host-receipt.ts`;
 * that evidence is transport-level and deliberately not mixed into this file.
 */

afterEach(() => {
  clearWorkingConstraints();
});

interface HarnessCalls {
  cancelTask: string[];
  dispatch: Array<{ text: string; cancelRunning: boolean; interruptedContext: InterruptedSpeechContext | null | undefined }>;
  resumed: number;
  unducked: number;
  bargeInConfirmed: number;
  interruptedPublished: Array<InterruptedSpeechContext | null>;
  pendingPublished: string[][];
}

const createHarness = () => {
  const calls: HarnessCalls = {
    cancelTask: [], dispatch: [], resumed: 0, unducked: 0, bargeInConfirmed: 0,
    interruptedPublished: [], pendingPublished: [],
  };
  const effectsFor = (transcript: string, interrupted: InterruptedSpeechContext | null): InterjectionEffects => ({
    transcript,
    turnId: 7,
    interrupted,
    unduck: () => { calls.unducked += 1; },
    confirmBargeIn: () => { calls.bargeInConfirmed += 1; },
    cancelTask: (taskId) => { calls.cancelTask.push(taskId); },
    dispatch: (text, options) => {
      calls.dispatch.push({ text, cancelRunning: options.cancelRunning, interruptedContext: options.interruptedContext });
    },
    queueConstraint: (text, turnId) => { appendWorkingConstraint(text, turnId); },
    pendingConstraints: () => getWorkingConstraints().map((item) => item.text),
    publishInterrupted: (context) => { calls.interruptedPublished.push(context); },
    publishPendingConstraints: (constraints) => { calls.pendingPublished.push([...constraints]); },
    resumePlayback: () => { calls.resumed += 1; },
  });
  return { calls, effectsFor };
};

const runInterjection = (input: {
  projection: TaskProjection | null;
  taskId: string | null;
  transcript: string;
  speechActive?: boolean;
  interrupted?: InterruptedSpeechContext | null;
}) => {
  const harness = createHarness();
  const decision = decideInterjection({
    intent: classifyIntent(input.transcript),
    transcript: input.transcript,
    speechActive: input.speechActive ?? false,
    task: input.projection,
    taskId: input.taskId,
  });
  const outcome = applyInterjection(decision, harness.effectsFor(input.transcript, input.interrupted ?? null));
  return { calls: harness.calls, decision, outcome };
};

/** Real `/api/intent` shape: a read-only query accepted and awaiting execution. */
const readOnlyInFlight = () => projectDecisionTask(
  { id: "task-ro", status: "awaiting_execution", step: 2, executionId: "exec_5f0c", canvasVersion: 7 },
  { mutationClass: inferTaskMutationClass("查一下明天上海的天气") },
);

/** Real `/api/intent` shape: a write (reminder) accepted and awaiting execution. */
const writeInFlight = () => projectDecisionTask(
  { id: "task-w", status: "awaiting_execution", step: 1, executionId: "exec_91ab", canvasVersion: 7 },
  { mutationClass: inferTaskMutationClass("十分钟后提醒我喝水") },
);

const interruptedDuringQuery: InterruptedSpeechContext = {
  interrupted: true,
  reason: "voice",
  requestId: "req-query-1",
  fullText: "正在查询明天上海的天气。",
  spokenText: "正在查询",
  truncated: true,
  playedMs: 420,
};

describe("① running + read_only → a new read-only command supersedes it once", () => {
  it("cancels the Host task exactly once and dispatches exactly one new turn", () => {
    const projection = readOnlyInFlight();
    // The Host receipt (step/executionId) makes this real in-flight read-only work.
    expect(projection).toMatchObject({ status: "running", step: 2, executionId: "exec_5f0c", canvasVersion: 7 });
    expect(projection.mutationClass).toBe("read_only");
    expect(projection.canSafelySupersede).toBe(true);

    const run = runInterjection({ projection, taskId: "task-ro", transcript: "查一下明天下午上海的天气" });

    expect(run.decision.cancelTaskId).toBe("task-ro");
    expect(run.decision.cancelRunning).toBe(true);
    expect(run.calls.cancelTask).toEqual(["task-ro"]);
    expect(run.calls.dispatch).toHaveLength(1);
    expect(run.calls.dispatch[0]).toMatchObject({ text: "查一下明天下午上海的天气", cancelRunning: true });
    // One supersede = one cancel + one dispatch. Nothing runs twice.
    expect(run.outcome).toEqual({ dispatchCount: 1, cancelCount: 1, queuedConstraint: false });
  });

  it("supersedes the same read-only task while the assistant is still speaking", () => {
    const run = runInterjection({
      projection: readOnlyInFlight(), taskId: "task-ro",
      transcript: "帮我看看明天的日程安排", speechActive: true, interrupted: interruptedDuringQuery,
    });
    expect(run.decision.captureInterrupted).toBe(true);
    expect(run.calls.interruptedPublished).toEqual([interruptedDuringQuery]);
    expect(run.calls.cancelTask).toEqual(["task-ro"]);
    expect(run.calls.dispatch).toHaveLength(1);
    expect(run.calls.dispatch[0]?.interruptedContext).toBe(interruptedDuringQuery);
  });

  it("stops superseding once the Host settled the task as completed", () => {
    const settled = projectDecisionTask(
      { id: "task-ro", status: "completed", step: 3, canvasVersion: 7 },
      { mutationClass: "read_only" },
    );
    expect(settled.isTerminal).toBe(true);
    expect(settled.canSafelySupersede).toBe(false);

    const run = runInterjection({ projection: settled, taskId: "task-ro", transcript: "换一个地方查天气" });
    expect(run.calls.cancelTask).toEqual([]);
    expect(run.calls.dispatch).toHaveLength(1);
    expect(run.calls.dispatch[0]?.cancelRunning).toBe(false);
    expect(run.outcome).toEqual({ dispatchCount: 1, cancelCount: 0, queuedConstraint: false });
  });
});

describe("② running + mutating → the write is never silently cancelled", () => {
  it("queues a follow-up constraint, dispatches nothing, and consumes it on the next turn", () => {
    const projection = writeInFlight();
    expect(projection.mutationClass).toBe("mutating");
    expect(projection.canSafelySupersede).toBe(false);

    const transcript = "另外再提醒我晚上八点吃药";
    expect(classifyIntent(transcript)).toBe("new_constraint");

    const run = runInterjection({ projection, taskId: "task-w", transcript });

    expect(run.decision).toMatchObject({
      queueConstraint: true, dispatch: false, cancelTaskId: null, cancelRunning: false,
    });
    expect(run.calls.cancelTask).toEqual([]);
    expect(run.calls.dispatch).toEqual([]);
    expect(getWorkingConstraints().map((item) => item.text)).toEqual([transcript]);
    expect(run.calls.pendingPublished.at(-1)).toEqual([transcript]);

    // The next planning turn consumes the queue exactly once and clears it.
    const consumed = consumeWorkingConstraints();
    expect(consumed.map((item) => item.text)).toEqual([transcript]);
    expect(consumed[0]?.turnId).toBe(7);
    expect(getWorkingConstraints()).toEqual([]);
    expect(consumeWorkingConstraints()).toEqual([]);
  });

  it("queues a constraint instead of cancelling while TTS is still speaking", () => {
    const run = runInterjection({
      projection: writeInFlight(), taskId: "task-w", transcript: "还有就是要下午的",
      speechActive: true, interrupted: interruptedDuringQuery,
    });
    expect(run.decision.captureInterrupted).toBe(true);
    expect(run.calls.cancelTask).toEqual([]);
    expect(run.calls.dispatch).toEqual([]);
    expect(getWorkingConstraints().map((item) => item.text)).toEqual(["还有就是要下午的"]);
  });

  it("dispatches a brand-new topic without cancelling the running write", () => {
    const run = runInterjection({ projection: writeInFlight(), taskId: "task-w", transcript: "换个话题聊聊杭州的秋天" });
    expect(run.calls.cancelTask).toEqual([]);
    expect(run.calls.dispatch).toHaveLength(1);
    // cancelRunning=false keeps ControlApp from aborting the pending write.
    expect(run.calls.dispatch[0]?.cancelRunning).toBe(false);
    expect(run.decision.cancelTaskId).toBeNull();
  });

  it("still honours an explicit cancel for the one captured write task", () => {
    const run = runInterjection({ projection: writeInFlight(), taskId: "task-w", transcript: "取消任务" });
    expect(run.calls.cancelTask).toEqual(["task-w"]);
    expect(run.calls.dispatch).toEqual([]);
    expect(run.decision.cancelRunning).toBe(false);
  });
});

describe("③ classifyTaskCancellationSafety matches the documented policy table", () => {
  it("read-only may abort; dispatched mutating must report; unknown asks first", () => {
    expect(classifyTaskCancellationSafety("read_only", false)).toBe("abort_immediately");
    expect(classifyTaskCancellationSafety("read_only", true)).toBe("abort_immediately");
    expect(classifyTaskCancellationSafety("mutating", false)).toBe("abort_immediately");
    expect(classifyTaskCancellationSafety("mutating", true)).toBe("report_result_no_silent_drop");
    expect(classifyTaskCancellationSafety("unknown", false)).toBe("require_confirmation");
    expect(classifyTaskCancellationSafety("unknown", true)).toBe("report_result_no_silent_drop");
  });

  it("uses the Host receipt (executionId) as the 'already dispatched' marker", () => {
    const projected = writeInFlight();
    expect(classifyTaskCancellationSafety(projected.mutationClass, projected.executionId !== undefined))
      .toBe("report_result_no_silent_drop");
    expect(projected.canSafelySupersede).toBe(false);
  });

  it("only read-only projections are supersede-safe, whatever the status", () => {
    for (const status of ["awaiting_execution", "accepted", "running"]) {
      expect(projectDecisionTask({ id: "ro", status, step: 1 }, { mutationClass: "read_only" }).canSafelySupersede).toBe(true);
      expect(projectDecisionTask({ id: "w", status, step: 1 }, { mutationClass: "mutating" }).canSafelySupersede).toBe(false);
      expect(projectDecisionTask({ id: "u", status, step: 1 }, { mutationClass: "unknown" }).canSafelySupersede).toBe(false);
    }
  });
});

describe("④ ordering + clarification guards around real Host receipts", () => {
  const at = (step: number, status: string, taskId = "t"): DecisionTaskStatusLike => ({ id: taskId, status, step });

  it("carries step / executionId / canvasVersion from the Host decision status", () => {
    const projection = projectDecisionTask(
      { id: "task-9", status: "awaiting_execution", step: 2, executionId: "exec_9f2", canvasVersion: 14 },
      { mutationClass: "read_only" },
    );
    expect(projection).toMatchObject({ taskId: "task-9", status: "running", step: 2, executionId: "exec_9f2", canvasVersion: 14 });
  });

  it("rejects a late older step and never re-opens settled work", () => {
    const latest = projectDecisionTask(at(3, "awaiting_execution"));
    expect(isStaleProjection(latest, projectDecisionTask(at(2, "awaiting_execution")))).toBe(true);
    expect(isStaleProjection(latest, projectDecisionTask(at(3, "awaiting_execution")))).toBe(false);

    const settled = projectDecisionTask(at(4, "completed"));
    expect(isStaleProjection(settled, projectDecisionTask(at(4, "awaiting_execution")))).toBe(true);
    expect(isStaleProjection(settled, projectDecisionTask(at(5, "completed")))).toBe(false);
    // A stale read-only frame must not re-arm a supersede the Host already settled.
    expect(isStaleProjection(settled, projectDecisionTask({ id: "t", status: "awaiting_execution", step: 3 }, { mutationClass: "read_only" }))).toBe(true);
  });

  it("does not compare steps across different Host tasks", () => {
    expect(isStaleProjection(projectDecisionTask(at(5, "awaiting_execution", "a")), projectDecisionTask(at(1, "awaiting_execution", "b")))).toBe(false);
    expect(isStaleProjection(null, projectDecisionTask(at(1, "awaiting_execution")))).toBe(false);
  });

  it("surfaces the Host clarification question as the projection message", () => {
    const projection = projectDecisionTask({
      id: "task-clarify", status: "awaiting_clarification", step: 1,
      clarification: { question: "要清空哪个 Space？" },
    });
    expect(projection.status).toBe("awaiting_clarification");
    expect(projection.message).toBe("要清空哪个 Space？");
    expect(projection.needsFeedback).toBe(true);
    expect(projection.canSafelySupersede).toBe(false);
  });
});
