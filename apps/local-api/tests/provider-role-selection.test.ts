import { describe, expect, it } from "vitest";
import { ProviderStore } from "../src/providers/store.js";
import { resolveSavedAsr } from "../src/providers/asr.js";
import { resolveSavedSpeech } from "../src/providers/speech.js";

/**
 * Product contract for multi-provider settings:
 *
 * 1. The user's newest enabled `main` row decides the planner transport, even
 *    when an older deployment seed (StepFun) is still enabled.
 * 2. A chat-only main row cannot drive speech: ASR/TTS fall back to an enabled
 *    StepFun `main` row when no dedicated row exists, regardless of which row
 *    wins the `main` role.
 */

const store = () => new ProviderStore({ dataDir: "C:\\nonexistent", persist: false });

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const stepFunMain = (target: ProviderStore, overrides: Record<string, unknown> = {}) => target.create({
  name: "StepFun (seed)", protocol: "stepfun-v1", baseUrl: "https://api.stepfun.com/v1",
  apiKey: "TEST-stepfun-key", model: "step-3.5-flash", roles: ["main"], ...overrides,
});

const deepSeekMain = (target: ProviderStore) => target.create({
  name: "DeepSeek 官方", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-test-deepseek-key", model: "deepseek-flash", roles: ["main"],
});

describe("main role ordering versus speech fallback", () => {
  it("picks the newer DeepSeek main row while ASR and TTS still borrow the StepFun key", async () => {
    const target = store();
    const stepfun = stepFunMain(target);
    await sleep(2);
    const deepseek = deepSeekMain(target);

    // The planner role follows the newest explicit choice, not the seed protocol.
    expect(target.findForRole("main")?.id).toBe(deepseek.id);

    // Speech cannot run on a chat-only row, so it still resolves the StepFun one.
    const asr = resolveSavedAsr(target) as { provider?: { id: string }; baseUrl?: string } | undefined;
    const speech = resolveSavedSpeech(target) as { saved?: { id: string } } | undefined;
    expect(asr?.provider?.id).toBe(stepfun.id);
    expect(asr?.baseUrl).toBe("https://api.stepfun.com/v1");
    expect(speech?.saved?.id).toBe(stepfun.id);
  });

  it("lets a dedicated ASR/TTS row beat the StepFun main fallback", async () => {
    const target = store();
    stepFunMain(target);
    await sleep(2);
    deepSeekMain(target);
    const dedicatedAsr = target.create({
      name: "StepFun ASR", protocol: "stepfun-v1", baseUrl: "https://api.stepfun.com/v1",
      apiKey: "TEST-asr-key", model: "stepaudio-2.5-asr", roles: ["asr"],
    });
    const dedicatedTts = target.create({
      name: "StepFun TTS", protocol: "stepfun-v1", baseUrl: "https://api.stepfun.com/v1",
      apiKey: "TEST-tts-key", model: "step-tts-mini", roles: ["tts"],
    });

    const asr = resolveSavedAsr(target) as { provider?: { id: string } } | undefined;
    const speech = resolveSavedSpeech(target) as { saved?: { id: string } } | undefined;
    expect(asr?.provider?.id).toBe(dedicatedAsr.id);
    expect(speech?.saved?.id).toBe(dedicatedTts.id);
  });
});
