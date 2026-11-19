import { authHeaders } from "./client.js";
import type { ProviderStore } from "./store.js";

export function resolveSavedAsr(store: ProviderStore) {
  const dedicated = store.findForRole("asr");
  if (!dedicated && store.list().some(provider => provider.roles.includes("asr"))) return { error: "语音识别连接已关闭，请在模型设置中启用 ASR。" };
  // The StepFun fallback must not depend on which `main` row happens to win the
  // role ordering: a newer DeepSeek/OpenAI main row is the correct planner
  // choice but cannot drive speech. Look for an enabled StepFun main row
  // explicitly, newest first, and let a dedicated ASR row always win.
  const speechCapableMain = store.list()
    .filter(entry => entry.enabled && entry.roles.includes("main") && entry.protocol.startsWith("stepfun"))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const provider = dedicated ?? speechCapableMain;
  if (!provider) return;
  const stepfun = provider.protocol.startsWith("stepfun");
  if (!stepfun && provider.protocol !== "openai-compatible") return { error: "所选 ASR 使用了非语音协议，请选择语音识别 API。" };
  const model = stepfun ? dedicated?.model ?? "stepaudio-2.5-asr" : provider.model;
  if (!model) return { error: "请为 ASR 连接选择语音识别模型。" };
  if (stepfun && !store.getApiKey(provider.id)?.trim()) return { error: "语音识别 API 未保存 Key，请重新连接。" };
  return { provider, baseUrl: provider.baseUrl.replace(/\/+$/, ""), model,
    headers: authHeaders({ ...provider, apiKey: store.getApiKey(provider.id) }),
    protocol: stepfun ? "sse" as const : "multipart" as const };
}
