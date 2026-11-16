export const FEEDBACK_SCENES = ["multi", "attachment", "continuation", "task"] as const;
export type FeedbackScene = (typeof FEEDBACK_SCENES)[number];

/** A target-sensitive route may speak an action only after a unique card is known. */
export const FEEDBACK_TARGET_STATES = ["unresolved", "resolved", "ambiguous", "missing"] as const;
export type FeedbackTargetState = (typeof FEEDBACK_TARGET_STATES)[number];

/**
 * The provisional first sentence may only describe work in progress. It must
 * never claim a finished action ("已为你创建卡片", "我帮你弄好了", "我创建了
 * 卡片") and must never leak wire/implementation detail. The backend uses this
 * as its hard gate; the web client re-runs it so a sentence that slips past an
 * older server still cannot reach the visible slot.
 */
export const UNSAFE_FEEDBACK_PATTERN = /[{}\[\]`<>\r\n]|(?:tools?\.|card\.|canvas\.|stage\.|slots|contract|sourceData|displayProps|targetId|itemId|requestId|metadata|reasoning|[A-Z][a-z]+Card)|已|完成|成功|好了|搞定|完毕|(?:弄|做|搞|处理)(?:完|好)|(?:创建|生成|设置|保存|删除|执行|记下)(?:了|好|完|过)|(?:saved|created|completed|done)\b/i;

/** `false` means: drop this first sentence and keep waiting for the result. */
export function isSafeFeedbackText(text: string): boolean {
  const value = text.trim();
  return value.length > 0 && Array.from(value).length <= 80 && !UNSAFE_FEEDBACK_PATTERN.test(value);
}

/** An explicit new command must not be consumed as an answer to an old question. */
export function startsNewInstruction(text: string, previousUtterance?: string): boolean {
  const value = text.trim();
  if (/^(?:你好|您好|嗨|嘿|哈喽|hello|hi|vivic)(?:[\s,，]*(?:vivic))?[\s!！。.,，~～]*$/iu.test(value)) return true;
  if (/^(?:请帮我|帮我|请|给我)?\s*(?:搜索|搜|查|创建|新建|添加|新增|(?:加|列)(?:一?[个张条]|几条|下)?\s*待办|删除|取消|打开|读取|阅读|显示|展示|恢复|撤销|聚焦|放大|高亮|选中|暂停|继续|展开|收起|折叠|重新排|整理|待办(?:事项|列表|卡片|卡)?\s*[:：])/.test(value)) return true;
  // Host-decided card operations (directOperations.ts) are always new instructions.
  if (/^(?:请|帮我|麻烦)?\s*(?:(?:把|将).{0,20}第[\d一二两三四五六七八九十]+[项条]|(?:把|将)?.{0,16}(?:便笺|便签|笔记).{0,4}(?:改成|改为|换成|更新为|更新成|写成|修改为|修改成)|(?:给|在|往|向).{0,16}待办.{0,6}(?:加|添加|追加|新增)|(?:删掉|删了|移除|去掉))/u.test(value)) return true;
  if (/提醒我|(?:把|将).*(?:待办|任务).*(?:完成|高亮)|(?:天气|气温)(?:卡片|卡)?(?:怎么样|如何)?[。？！?!]?$/.test(value)) return true;
  // A duration can answer “delete which timer?”. Otherwise it starts a new
  // timer instead of inheriting an unrelated failed weather/plan question.
  return /倒计时/.test(value) && !/删除|删掉|移除|聚焦|放大|暂停|继续/.test(previousUtterance ?? "");
}
