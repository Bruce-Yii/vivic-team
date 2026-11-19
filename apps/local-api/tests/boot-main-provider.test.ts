import { describe, expect, it } from "vitest";
import { resolveBootMainProvider } from "../src/providers/main.js";

/**
 * DeepSeek is the product default (materially faster and cheaper than the plan
 * path), but the default must never brick a deployment that only ever saved a
 * StepFun main row.
 */

const stepfunRow = { enabled: true, roles: ["main"], protocol: "stepfun-v1", baseUrl: "https://api.stepfun.com/v1" };
const deepseekRow = { enabled: true, roles: ["main"], protocol: "openai-compatible", baseUrl: "https://api.deepseek.com/v1" };

describe("boot main provider", () => {
  it("defaults to DeepSeek when nothing is configured", () => {
    expect(resolveBootMainProvider(undefined, {})).toBe("deepseek");
  });

  it("honours an explicit stepfun switch", () => {
    expect(resolveBootMainProvider("stepfun", { deepseekApiKey: "sk-x" })).toBe("stepfun");
  });

  it("keeps DeepSeek when a key is present, even after a StepFun seed row", () => {
    expect(resolveBootMainProvider(undefined, { deepseekApiKey: "sk-x", rows: [stepfunRow] })).toBe("deepseek");
    expect(resolveBootMainProvider(undefined, { rows: [stepfunRow, deepseekRow] })).toBe("deepseek");
  });

  it("falls back to StepFun when there is no DeepSeek key and only a StepFun row", () => {
    expect(resolveBootMainProvider(undefined, { rows: [stepfunRow] })).toBe("stepfun");
  });

  it("stays on DeepSeek when no provider row exists at all (honest缺凭据 error)", () => {
    expect(resolveBootMainProvider(undefined, { rows: [] })).toBe("deepseek");
  });
});
