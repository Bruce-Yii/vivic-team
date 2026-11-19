import { describe, expect, it } from "vitest";
import { resolveStepfunAsrBackend } from "../src/asrGatewayServer.js";
import { loadConfig, STEPFUN_API_BASE_URL, STEPFUN_PLAN_BASE_URL } from "../src/config.js";

/**
 * Speech must never be requested from the Coding-Plan base: `/step_plan/v1`
 * serves plan chat completions only, while streaming transcription lives at
 * `/v1/audio/asr/sse`. This guards the env-key/credential deployment path,
 * which has no provider store row to inherit a base URL from.
 */

const baseConfig = () => loadConfig({} as NodeJS.ProcessEnv);

describe("StepFun ASR backend resolution", () => {
  it("defaults to the official /v1 base, never the Coding-Plan base", () => {
    const config = baseConfig();
    expect(config.stepfunAsrBaseUrl).toBe(STEPFUN_API_BASE_URL);
    expect(config.stepfunAsrBaseUrl).not.toBe(STEPFUN_PLAN_BASE_URL);
    // The planner base stays on the plan endpoint; the two are intentionally different.
    // The normal pay-as-you-go API is the default for chat AND speech; the plan base
    // only appears when an operator opts in explicitly.
    expect(config.stepfunBaseUrl).toBe(STEPFUN_API_BASE_URL);
    expect(loadConfig({ STEPFUN_BASE_URL: STEPFUN_PLAN_BASE_URL } as unknown as NodeJS.ProcessEnv).stepfunBaseUrl)
      .toBe(STEPFUN_PLAN_BASE_URL);
  });

  it("honours an operator override with trailing slashes trimmed", () => {
    const config = loadConfig({ VIVIC_STEPFUN_ASR_BASE_URL: "https://asr.example.com/v1/" } as unknown as NodeJS.ProcessEnv);
    expect(config.stepfunAsrBaseUrl).toBe("https://asr.example.com/v1");
  });

  it("builds the env-key backend against the official base", () => {
    const config = baseConfig();
    const backend = resolveStepfunAsrBackend({ config, env: { VIVIC_STEPFUN_API_KEY: "TEST-stepfun-key" } });
    expect(backend).toMatchObject({
      baseUrl: STEPFUN_API_BASE_URL,
      model: "stepaudio-2.5-asr",
      protocol: "sse",
      headers: { authorization: "Bearer TEST-stepfun-key" },
    });
    // The request the provider will actually make.
    expect(`${(backend as { baseUrl: string }).baseUrl}/audio/asr/sse`).toBe("https://api.stepfun.com/v1/audio/asr/sse");
  });

  it("returns undefined instead of falling back to the plan base when no key exists", () => {
    const config = baseConfig();
    expect(resolveStepfunAsrBackend({ config, env: {} })).toBeUndefined();
  });
});
