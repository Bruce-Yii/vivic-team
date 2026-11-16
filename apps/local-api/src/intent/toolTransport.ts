import type { StepfunCredential } from "../credentials.js";
import { providerMessages, type ChatMessage, type StepfunDeps, type StepfunResult } from "../stepfun.js";
import { attachTokenUsage, normalizeTokenUsage } from "../observability/tokenUsage.js";
import { createBudget } from "./budget.js";
import type { ToolCall, ToolDefinition } from "./toolCalls.js";

/**
 * OpenAI-compatible tool-calling transport (local experiment).
 *
 * One request, `tools` + `tool_choice:"auto"`. `requestToolCalls` is the
 * non-streaming form; `streamToolCalls` streams the same response so the caller
 * can publish a real tool-name hint as soon as the model has chosen a tool —
 * before its arguments are complete and before anything is committed.
 *
 * This module never executes anything and never returns card records.
 */
export interface ToolTransportOptions {
  maxTokens?: number;
  temperature?: number;
}

export interface ToolStreamHandlers {
  /** Fired once per tool index when its name is complete and arguments start. */
  onToolName?: (name: string, index: number) => void;
}

interface ChatCompletionToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionResponse {
  choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null; tool_calls?: ChatCompletionToolCall[] } }>;
  error?: { message?: string };
  usage?: unknown;
}

interface StreamPayload {
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    delta?: { content?: string | null; tool_calls?: ChatCompletionToolCall[] };
  }>;
  error?: unknown;
  usage?: unknown;
}

const TOOL_TIMEOUT_MS = 30_000;

const parseArguments = (raw: string | undefined, name: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } => {
  if (!raw || !raw.trim()) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: `工具 ${name} 的参数不是合法 JSON 对象` };
  }
};

const callsFromPairs = (pairs: Array<{ name: string; arguments: string }>): StepfunResult<ToolCall[]> => {
  const calls: ToolCall[] = [];
  for (const pair of pairs) {
    const parsed = parseArguments(pair.arguments, pair.name);
    if (!parsed.ok) return { ok: false, code: "invalid-response", error: parsed.error };
    calls.push({ name: pair.name, arguments: parsed.value });
  }
  return { ok: true, value: calls };
};

/** Attaches the provider's usage counter to a successful transport result. */
const withUsage = <T>(result: StepfunResult<T>, raw: unknown, model: string): StepfunResult<T> => {
  if (!result.ok) return result;
  return attachTokenUsage(result, normalizeTokenUsage(raw, model));
};

const mapMessageCalls = (raw: ChatCompletionToolCall[] | undefined): StepfunResult<ToolCall[]> => {
  if (!Array.isArray(raw)) return { ok: true, value: [] };
  const named: Array<{ name: string; arguments: string }> = [];
  for (const item of raw) {
    const name = item?.function?.name;
    if (typeof name !== "string" || !name) return { ok: false, code: "invalid-response", error: "工具调用缺少工具名" };
    named.push({ name, arguments: item.function?.arguments ?? "" });
  }
  return callsFromPairs(named);
};

/** Shared request body; only `stream` differs between the two transports. */
const buildBody = (credential: StepfunCredential, messages: ChatMessage[], tools: ToolDefinition[], options: ToolTransportOptions | undefined, stream: boolean) => JSON.stringify({
  model: credential.defaultModel,
  // Same message shape as the planner: an attached image travels as content
  // parts, so the tool turn can analyse what the user sent.
  messages: providerMessages(messages),
  tools,
  tool_choice: "auto",
  temperature: options?.temperature ?? 0,
  max_tokens: options?.maxTokens ?? 512,
  ...(stream ? { stream: true } : {}),
  // DeepSeek reports a streamed turn's usage only when asked; the frame is a
  // usage-only chunk before [DONE]. Other providers keep the old body.
  ...(stream && credential.defaultModel.startsWith("deepseek") ? { stream_options: { include_usage: true } } : {}),
});

export async function requestToolCalls(
  credential: StepfunCredential,
  messages: ChatMessage[],
  deps: StepfunDeps,
  tools: ToolDefinition[],
  options?: ToolTransportOptions,
): Promise<StepfunResult<ToolCall[]>> {
  const budget = createBudget(deps.timeoutMs ?? TOOL_TIMEOUT_MS, [deps.signal]);
  try {
    return await budget.run(async () => {
      const fetchImpl = deps.fetchImpl ?? fetch;
      const base = deps.baseUrl.replace(/\/+$/, "");
      let res: Response;
      try {
        res = await fetchImpl(`${base}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${credential.apiKey}` },
          body: buildBody(credential, messages, tools, options, false),
          signal: budget.signal,
          redirect: "error",
        });
      } catch {
        return { ok: false, code: "network" as const, error: "工具调用请求失败：网络不可用或已取消" };
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, code: "provider" as const, status: res.status, error: "工具调用失败：模型凭据无效" };
      }
      if (!res.ok) {
        return { ok: false, code: "provider" as const, status: res.status, error: `工具调用失败（HTTP ${res.status}）` };
      }
      let body: ChatCompletionResponse;
      try {
        body = (await res.json()) as ChatCompletionResponse;
      } catch {
        return { ok: false, code: "invalid-response" as const, error: "工具调用返回了无法解析的响应" };
      }
      const choice = body.choices?.[0];
      const mapped = mapMessageCalls(choice?.message?.tool_calls);
      if (choice?.finish_reason === "length") {
        return { ok: false, code: "invalid-response" as const,
          error: "工具调用输出被截断（max_tokens 用尽）：请精简思考与参数后重试" };
      }
      return withUsage(mapped, body.usage, credential.defaultModel);
    });
  } finally {
    budget.dispose();
  }
}

/**
 * Streaming transport. The model's first tool name is available long before the
 * full arguments; `onToolName` lets the pipeline publish an honest "I'm working
 * on X" line while the host still waits for the complete, validated call.
 */
export async function streamToolCalls(
  credential: StepfunCredential,
  messages: ChatMessage[],
  deps: StepfunDeps,
  tools: ToolDefinition[],
  options: ToolTransportOptions | undefined,
  handlers: ToolStreamHandlers = {},
): Promise<StepfunResult<ToolCall[]>> {
  const budget = createBudget(deps.timeoutMs ?? TOOL_TIMEOUT_MS, [deps.signal]);
  try {
    return await budget.run(async () => {
      const fetchImpl = deps.fetchImpl ?? fetch;
      const base = deps.baseUrl.replace(/\/+$/, "");
      let res: Response;
      try {
        res = await fetchImpl(`${base}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${credential.apiKey}` },
          body: buildBody(credential, messages, tools, options, true),
          signal: budget.signal,
          redirect: "error",
        });
      } catch {
        return { ok: false, code: "network" as const, error: "工具调用请求失败：网络不可用或已取消" };
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, code: "provider" as const, status: res.status, error: "工具调用失败：模型凭据无效" };
      }
      if (!res.ok) {
        return { ok: false, code: "provider" as const, status: res.status, error: `工具调用失败（HTTP ${res.status}）` };
      }
      // A gateway may ignore `stream`; keep the non-streaming body path usable.
      if (res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream") {
        try {
          const body = (await res.json()) as ChatCompletionResponse;
          const choice = body.choices?.[0];
      const mapped = mapMessageCalls(choice?.message?.tool_calls);
      if (choice?.finish_reason === "length") {
        return { ok: false, code: "invalid-response" as const,
          error: "工具调用输出被截断（max_tokens 用尽）：请精简思考与参数后重试" };
      }
      return withUsage(mapped, body.usage, credential.defaultModel);
        } catch {
          return { ok: false, code: "invalid-response" as const, error: "工具调用返回了无法解析的响应" };
        }
      }
      if (!res.body) return { ok: false, code: "invalid-response" as const, error: "工具调用流为空" };

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const abort = () => { void reader.cancel().catch(() => undefined); };
      budget.signal.addEventListener("abort", abort, { once: true });
      const entries = new Map<number, { name: string; args: string; started: boolean; announced: boolean }>();
      let pending = "";
      let dataLines: string[] = [];
      let done = false;
      let usage: unknown;
      let truncated = false;

      const announce = (index: number) => {
        const entry = entries.get(index);
        if (!entry || entry.announced || !entry.started || !entry.name) return;
        entry.announced = true;
        try { handlers.onToolName?.(entry.name, index); } catch { /* progress is advisory */ }
      };

      const dispatch = () => {
        if (!dataLines.length) return;
        const value = dataLines.join("\n");
        dataLines = [];
        if (!value.trim()) return;
        budget.signal.throwIfAborted();
        if (value.trim() === "[DONE]") { done = true; return; }
        let payload: StreamPayload;
        try { payload = JSON.parse(value) as StreamPayload; } catch {
          throw new TypeError("工具调用流帧不可解析");
        }
        if (payload && typeof payload === "object" && "error" in payload && payload.error != null) {
          throw new TypeError("工具调用上游返回错误帧");
        }
        // A usage-only final frame (or usage riding along with the last delta)
        // is the only place a streamed turn reports its cost.
        if (payload && typeof payload === "object" && payload.usage != null) usage = payload.usage;
        if (!payload || !Array.isArray(payload.choices)) return;
        const choice = payload.choices[0];
        if (!choice) return;
        for (const call of choice.delta?.tool_calls ?? []) {
          const index = call.index ?? 0;
          const entry = entries.get(index) ?? { name: "", args: "", started: false, announced: false };
          if (typeof call.function?.name === "string" && call.function.name) entry.name += call.function.name;
          if (call.function?.arguments !== undefined) {
            entry.started = true;
            if (typeof call.function.arguments === "string") entry.args += call.function.arguments;
          }
          entries.set(index, entry);
          announce(index);
        }
        if (choice.finish_reason === "content_filter") throw new TypeError("工具调用被内容策略拦截");
        if (choice.finish_reason === "length") truncated = true;
      };

      const onLine = (line: string) => {
        if (!line) { dispatch(); return; }
        if (line.startsWith(":")) return;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        if (field === "data") dataLines.push(colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, ""));
      };

      try {
        budget.signal.throwIfAborted();
        while (!done) {
          const next = await reader.read();
          budget.signal.throwIfAborted();
          pending += decoder.decode(next.value, { stream: !next.done });
          let newline = pending.indexOf("\n");
          while (newline >= 0) {
            const line = pending.slice(0, newline).replace(/\r$/, "");
            pending = pending.slice(newline + 1);
            onLine(line);
            newline = pending.indexOf("\n");
          }
          if (next.done) break;
        }
        pending += decoder.decode();
        if (pending) onLine(pending.replace(/\r$/, ""));
        dispatch();
      } catch {
        budget.signal.throwIfAborted();
        return { ok: false, code: "invalid-response" as const, error: "工具调用流解析失败" };
      } finally {
        budget.signal.removeEventListener("abort", abort);
        void reader.cancel().catch(() => undefined);
      }
      if (truncated) return { ok: false, code: "invalid-response" as const,
        error: "工具调用输出被截断（max_tokens 用尽）：请精简思考与参数后重试" };
      const pairs = [...entries.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => ({ name: entry.name, arguments: entry.args }));
      if (pairs.some(pair => !pair.name)) return { ok: false, code: "invalid-response" as const, error: "工具调用缺少工具名" };
      return withUsage(callsFromPairs(pairs), usage, credential.defaultModel);
    });
  } finally {
    budget.dispose();
  }
}
