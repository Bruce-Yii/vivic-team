/** P4 read-only Task Projection — bridges existing Hosted Tasks to the
 * Realtime Session Coordinator without creating a separate task system.
 * This is a READ-ONLY view of Hosted Task state for the frontend. */

export interface TaskProjection {
  taskId: string;
  status: "accepted" | "running" | "awaiting_clarification" | "succeeded" | "failed" | "cancelled" | "unknown";
  message: string;
  createdCardIds: string[];
  focusCardId?: string;
  isActive: boolean;
  isTerminal: boolean;
  needsFeedback: boolean;
}

export function projectTask(task: {
  id: string;
  status: string;
  message: string;
  createdCardIds?: string[];
  focusCardId?: string;
}): TaskProjection {
  const terminal = ["succeeded", "completed", "failed", "cancelled", "unknown", "awaiting_clarification"].includes(task.status);
  return {
    taskId: task.id,
    status: task.status as TaskProjection["status"],
    message: task.message,
    createdCardIds: task.createdCardIds ?? [],
    focusCardId: task.focusCardId,
    isActive: !terminal && task.status !== "awaiting_clarification",
    isTerminal: terminal,
    needsFeedback: task.status === "awaiting_clarification" || task.status === "succeeded" || task.status === "failed",
  };
}

export function isActiveTask(projection: TaskProjection): boolean {
  return projection.isActive;
}

export function needsUserFeedback(projection: TaskProjection): boolean {
  return projection.needsFeedback;
}