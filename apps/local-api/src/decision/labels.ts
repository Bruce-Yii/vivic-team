/** The seven labels every decision provider decodes its score vector into.
 *  They describe canvas-view commands only; no card, target, schedule or
 *  capability choice is expressed here. */
export const DECISION_ACTIONS = ["fit", "restore", "focus", "delete", "expand", "collapse", "other"] as const;

/** Direct-execution gate for a scored label vector (see
 * docs/decisions/decision-thresholds.md): top probability 0.8 plus a 0.25 lead
 * over the runner-up. Both are conservative, uncalibrated engineering gates, and
 * destructive, negative, quoted or compound input never executes.
 *
 * This is a validation gate over a provider's own output, not a route: it can
 * only narrow what the model runtime may report, never pick an action on its
 * behalf. */
export function acceptedDecision(text: string, probabilities: number[]): typeof DECISION_ACTIONS[number] | null {
  if (/不|别|没|无须|如果|然后|并且|同时|顺便|再|先|和|以及|或者|也要|还要|文档里|例如|例子|引用|什么意思|解释|忽略|删除|删掉|移除|取消|\bnot\b|\bnever\b|[；;\n「」“”"']/i.test(text)) return null;
  const ranked = probabilities.map((p, index) => ({ p, index })).sort((a, b) => b.p - a.p);
  if (ranked.length !== 7 || ranked.some(row => !Number.isFinite(row.p) || row.p < 0 || row.p > 1)
    || Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > .01
    || ranked[0]!.p < .8 || ranked[0]!.p - ranked[1]!.p < .25) return null;
  const action = DECISION_ACTIONS[ranked[0]!.index]!;
  if (action === "delete" || action === "other") return null;
  const vocabulary = { fit: /卡片|画布|一屏|全景|全局|整体|全部|所有/, restore: /恢复|原|之前|返回|退出|退回|回到|焦点/,
    focus: /看|放大|聚焦|关注|拉近|突出|重点/, expand: /展|全部|完整|全文|铺|细节|更多|摊|内容/, collapse: /收|简|缩|概要|叠|折|少|紧凑/ };
  return vocabulary[action].test(text) ? action : null;
}
