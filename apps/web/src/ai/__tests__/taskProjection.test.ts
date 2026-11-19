import { describe, expect, it } from "vitest";
import {
  inferTaskMutationClass, isStaleProjection, mapDecisionStatus, projectDecisionTask, projectTask,
} from "../taskProjection";

/**
 * The coordinator's task view must mirror the Host's real decision-task state.
 * These tests pin the receipt fields (step / executionId / canvasVersion) and the
 * ordering rules that keep an out-of-order frame from reopening settled work.
 */

describe("decision protocol status mapping", () => {
  it("maps the Host vocabulary without upgrading unknown values", () => {
    expect(mapDecisionStatus("awaiting_execution")).toBe("running");
    expect(mapDecisionStatus("completed")).toBe("succeeded");
    expect(mapDecisionStatus("awaiting_clarification")).toBe("awaiting_clarification");
    expect(mapDecisionStatus("cancelled")).toBe("cancelled");
    expect(mapDecisionStatus("failed")).toBe("failed");
    expect(mapDecisionStatus("something-new")).toBe("unknown");
  });

  it("treats awaiting_execution as real accepted work, not as an idle task", () => {
    const projection = projectTask({ id: "t1", status: "awaiting_execution", message: "执行中" });
    expect(projection.status).toBe("running");
    expect(projection.isActive).toBe(true);
    expect(projection.isTerminal).toBe(false);
  });
});

describe("projection of a real Host task status", () => {
  it("carries step, execution receipt id and canvas version through", () => {
    const projection = projectDecisionTask({
      id: "task-1", status: "awaiting_execution", step: 2,
      executionId: "exec-9f2", canvasVersion: 14,
    }, { mutationClass: "mutating" });
    expect(projection).toMatchObject({
      taskId: "task-1", status: "running", step: 2,
      executionId: "exec-9f2", canvasVersion: 14, mutationClass: "mutating",
    });
    // A mutating task in flight is never safe to silently supersede.
    expect(projection.canSafelySupersede).toBe(false);
  });

  it("falls back to the clarification question when the Host has no message", () => {
    const projection = projectDecisionTask({
      id: "task-2", status: "awaiting_clarification", step: 1,
      clarification: { question: "要清空哪个 Space？" },
    });
    expect(projection.message).toBe("要清空哪个 Space？");
    expect(projection.needsFeedback).toBe(true);
  });

  it("lets a read-only in-flight task be superseded, and stops once it is terminal", () => {
    const running = projectDecisionTask({ id: "task-3", status: "awaiting_execution", step: 1 },
      { mutationClass: inferTaskMutationClass("查一下上海天气") });
    expect(running.mutationClass).toBe("read_only");
    expect(running.canSafelySupersede).toBe(true);

    const done = projectDecisionTask({ id: "task-3", status: "completed", step: 2 },
      { mutationClass: "read_only" });
    expect(done.status).toBe("succeeded");
    expect(done.isTerminal).toBe(true);
    expect(done.canSafelySupersede).toBe(false);
  });
});

describe("ordering guard for out-of-order frames", () => {
  const at = (step: number, status: string, taskId = "t") =>
    projectTask({ id: taskId, status, message: "", step });

  it("rejects an older step arriving after a newer one", () => {
    expect(isStaleProjection(at(3, "awaiting_execution"), at(2, "awaiting_execution"))).toBe(true);
    expect(isStaleProjection(at(2, "awaiting_execution"), at(3, "awaiting_execution"))).toBe(false);
  });

  it("rejects a duplicate in-flight frame at the same step once the task is terminal", () => {
    expect(isStaleProjection(at(2, "completed"), at(2, "awaiting_execution"))).toBe(true);
    expect(isStaleProjection(at(2, "awaiting_execution"), at(2, "completed"))).toBe(false);
  });

  it("does not compare steps across different tasks", () => {
    expect(isStaleProjection(at(5, "awaiting_execution", "a"), at(1, "awaiting_execution", "b"))).toBe(false);
    expect(isStaleProjection(null, at(1, "awaiting_execution"))).toBe(false);
  });
});
