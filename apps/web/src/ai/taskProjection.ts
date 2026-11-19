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
  /** Monotonic decision-task step from the Host; later steps supersede earlier ones. */
  step: number;
  /** Real execution receipt id when the Host has started executing this task. */
  executionId?: string;
  /** Space version the decision was planned against (real Host version, not a local guess). */
  canvasVersion?: number;
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

/**
 * Map the decision protocol vocabulary (`DecisionTaskStatus.status`) onto the
 * projection vocabulary. `awaiting_execution` is real, accepted work in flight;
 * `completed` is a succeeded task. Unknown wire values stay `unknown` instead of
 * being cast into a stronger claim.
 */
export function mapDecisionStatus(status: string): TaskProjection["status"] {
  switch (status) {
    case "awaiting_execution": return "running";
    case "completed": return "succeeded";
    case "awaiting_clarification": return "awaiting_clarification";
    case "cancelled": return "cancelled";
    case "failed": return "failed";
    case "accepted": return "accepted";
    case "running": return "running";
    case "succeeded": return "succeeded";
    default: return "unknown";
  }
}

export function projectTask(task: {
  id: string;
  status: string;
  message: string;
  createdCardIds?: string[];
  focusCardId?: string;
  step?: number;
  executionId?: string;
  canvasVersion?: number;
  mutationClass?: TaskMutationClass;
}): TaskProjection {
  const status = mapDecisionStatus(task.status);
  const terminal = ["succeeded", "failed", "cancelled", "unknown", "awaiting_clarification"].includes(status);
  const isActive = !terminal;
  const mutationClass: TaskMutationClass = task.mutationClass ?? "unknown";
  return {
    taskId: task.id,
    status,
    message: task.message,
    createdCardIds: task.createdCardIds ?? [],
    focusCardId: task.focusCardId,
    step: task.step ?? 0,
    executionId: task.executionId,
    canvasVersion: task.canvasVersion,
    mutationClass,
    canSafelySupersede: isActive && mutationClass === "read_only",
    isActive,
    isTerminal: terminal,
    needsFeedback: status === "awaiting_clarification" || status === "succeeded" || status === "failed",
  };
}

export function isActiveTask(projection: TaskProjection): boolean {
  return projection.isActive;
}

export function needsUserFeedback(projection: TaskProjection): boolean {
  return projection.needsFeedback;
}

/** Wire shape of a real Host decision-task status (`DecisionTaskStatusSchema`). */
export interface DecisionTaskStatusLike {
  id: string;
  status: string;
  step: number;
  executionId?: string;
  canvasVersion?: number;
  reason?: string;
  clarification?: { question: string };
}

/**
 * Project a real `/api/intent` task status (the Host's decision protocol) into
 * the read-only coordinator view. The receipt fields (`step`, `executionId`,
 * `canvasVersion`) are carried through so the coordinator reasons about the
 * Host's actual progress instead of a local guess.
 */
export function projectDecisionTask(
  task: DecisionTaskStatusLike,
  options: { message?: string; mutationClass?: TaskMutationClass; createdCardIds?: string[]; focusCardId?: string } = {},
): TaskProjection {
  const message = options.message ?? task.clarification?.question ?? task.reason ?? "";
  return projectTask({
    id: task.id,
    status: task.status,
    message,
    createdCardIds: options.createdCardIds,
    focusCardId: options.focusCardId,
    step: task.step,
    executionId: task.executionId,
    canvasVersion: task.canvasVersion,
    mutationClass: options.mutationClass,
  });
}

/**
 * True when `next` is older than `current` for the same task. Out-of-order
 * responses (a slow earlier step landing after a newer one) must not regress the
 * projection and re-open supersede decisions the Host has already settled.
 */
export function isStaleProjection(current: TaskProjection | null, next: TaskProjection): boolean {
  if (!current) return false;
  if (current.taskId !== next.taskId) return false;
  if (next.step < current.step) return true;
  // Same step: a terminal state must not be reopened by a duplicate in-flight frame.
  if (next.step === current.step && current.isTerminal && !next.isTerminal) return true;
  return false;
}
