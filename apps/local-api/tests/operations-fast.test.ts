import { describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/credentials.js";
import { runIntent, type PipelineDeps } from "../src/intent/pipeline.js";
import { fastHostOperation } from "../src/intent/operationsFast.js";
import type { StepfunResult } from "../src/stepfun.js";
import { emptyContext } from "./helpers.js";

/**
 * Pure canvas operations (显示全部/显示所有/全部显示, 撤销/重做, 恢复视图, 自动整理
 * 画布) are whole-sentence commands the host can decide alone. They must reach
 * the answer with ZERO model calls, and a negated or multi-action sentence must
 * not be half-executed — it goes back to the model.
 */

const setup = () => {
  const generate = vi.fn(async (): Promise<StepfunResult<unknown>> => ({ ok: true, value: { clarify: "请补充要求。" } }));
  const deps: PipelineDeps = {
    credentials: new CredentialStore(),
    stepfun: { baseUrl: "https://unused.test" },
    planner: { provider: "gpt", connected: true, isCurrent: () => true, generate },
  };
  return { deps, generate };
};

const run = (text: string, deps: PipelineDeps) => runIntent({ text, canvasContext: emptyContext() }, deps);

describe("whole-sentence pure operations never call a model", () => {
  it.each(["显示全部", "显示所有", "全部显示"])("fits the canvas for %s", async text => {
    const f = setup();
    const result = await run(text, f.deps);
    expect(result.kind).toBe("envelope");
    expect(result.envelope?.actions).toEqual([{ type: "canvas.fit" }]);
    expect(result.usedProvider).toBe("rules");
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("restores the view without a model", async () => {
    const f = setup();
    const result = await run("恢复视图", f.deps);
    expect(result.kind).toBe("envelope");
    expect(result.envelope?.actions).toEqual([{ type: "canvas.restore" }]);
    expect(f.generate).not.toHaveBeenCalled();
  });

  it.each(["撤销", "撤销上一步"])("undoes through the host for %s", async text => {
    const f = setup();
    const result = await run(text, f.deps);
    expect(result.kind).toBe("host-operation");
    expect(result.hostOperation).toEqual({ kind: "history.undo" });
    expect(result.message).toBe("已撤销上一步");
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("redoes through the host", async () => {
    const f = setup();
    const result = await run("重做", f.deps);
    expect(result.kind).toBe("host-operation");
    expect(result.hostOperation).toEqual({ kind: "history.redo" });
    expect(f.generate).not.toHaveBeenCalled();
  });

  it.each(["自动整理画布", "整理画布", "自动整理"])("arranges the canvas through the host for %s", async text => {
    const f = setup();
    const result = await run(text, f.deps);
    expect(result.kind).toBe("host-operation");
    expect(result.hostOperation).toEqual({ kind: "canvas.arrange" });
    expect(f.generate).not.toHaveBeenCalled();
  });

  it.each(["不要撤销", "撤销然后重做", "显示全部再整理", "帮我撤销一下", "撤销和重做"])(
    "leaves %s to the model instead of half-executing it", async text => {
      const f = setup();
      const result = await run(text, f.deps);
      expect(result.kind).not.toBe("host-operation");
      expect(result.envelope).toBeUndefined();
      expect(f.generate).toHaveBeenCalled();
    });
});

describe("fastHostOperation is a closed table", () => {
  it("maps the four groups to host operations and a finished line", () => {
    expect(fastHostOperation("撤销")).toEqual({ hostOperation: { kind: "history.undo" }, message: "已撤销上一步" });
    expect(fastHostOperation("重做上一步。")).toEqual({ hostOperation: { kind: "history.redo" }, message: "已重做上一步" });
    expect(fastHostOperation("自动整理画布")).toEqual({ hostOperation: { kind: "canvas.arrange" }, message: "已自动整理画布" });
    expect(fastHostOperation("按类型分区")).toEqual({
      hostOperation: { kind: "canvas.organize.preview", sort: "manual", direction: "asc", group: "type" },
      message: "已打开整理预览",
    });
  });

  it.each(["不要撤销", "别整理画布", "撤销，然后整理画布", "撤销和重做", "如果撤销呢", "撤销是什么意思？"])(
    "refuses a negated, conditional or multi-action sentence: %s", text => {
      expect(fastHostOperation(text)).toBeNull();
    });

  it("ignores an empty or oversized sentence", () => {
    expect(fastHostOperation("   ")).toBeNull();
    expect(fastHostOperation(`撤销${"画布".repeat(30)}`)).toBeNull();
  });
});
