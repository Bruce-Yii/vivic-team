/** P4 read-only Task Projection — bridges existing Hosted Tasks to the
 * Realtime Session Coordinator without creating a separate task system.
 * This is a READ-ONLY view of Hosted Task state for the frontend. */

export type TaskMutationClass = "read_only" | "mutating" | "unknown";

export interface TaskProjection {
  taskId: string;
  status: "accepted" | "running" | "awaiting_clarification" | "succeeded" | "failed" | "cancelled" | "unknown";
  message: string;
  createdCardIds: string[];
  focusCardId?: string;
  mutationClass: TaskMutationClass;
  /** True only when the running task is read-only and may be safely superseded by a new turn. */
  canSafelySupersede: boolean;
  isActive: boolean;
  isTerminal: boolean;
  needsFeedback: boolean;
}

const MUTATING_PATTERN =
  /删|移除|清空|修改|编辑|更新|新建|创建|加个|添加|新增|提醒|倒计时|移动|固定|取消固定|撤销|重做|排序|整理|发送|预订|下单|保存|记一下|改(?:成|为|到|一下)/;
const READ_ONLY_PATTERN =
  /^(?:查|查询|查一下|搜|搜索|找|找一下|看|看看|看一下|聚焦|打开|显示全部|恢复视图|我在哪)|天气|多少度|航班|机票|酒店|景点|汇率|股价|新闻|介绍|是什么|怎么样/;

/**
 * Conservative client-side mutation classifier for in-flight utterances.
 * Mutating keywords always win over read-only keywords (e.g. compound requests
 * like "查天气然后删待办" stay protected as "mutating").
 */
export function inferTaskMutationClass(text: string): TaskMutationClass {
  const trimmed = text.trim();
  if (!trimmed) return "unknown";
  if (MUTATING_PATTERN.test(trimmed)) return "mutating";
  if (READ_ONLY_PATTERN.test(trimmed)) return "read_only";
  return "unknown";
}

export function projectTask(task: {
  id: string;
  status: string;
  message: string;
  createdCardIds?: string[];
  focusCardId?: string;
  mutationClass?: TaskMutationClass;
}): TaskProjection {
  const terminal = ["succeeded", "completed", "failed", "cancelled", "unknown", "awaiting_clarification"].includes(task.status);
  const isActive = !terminal && task.status !== "awaiting_clarification";
  const mutationClass: TaskMutationClass = task.mutationClass ?? "unknown";
  return {
    taskId: task.id,
    status: task.status as TaskProjection["status"],
    message: task.message,
    createdCardIds: task.createdCardIds ?? [],
    focusCardId: task.focusCardId,
    mutationClass,
    canSafelySupersede: isActive && mutationClass === "read_only",
    isActive,
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
