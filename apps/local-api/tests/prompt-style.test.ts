import { afterEach, describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/intent/prompt.js";
import { replyStyleInstruction, resolveReplyStyle } from "../src/intent/style.js";
import { buildToolSystemPrompt } from "../src/intent/toolCalls.js";
import { emptyContext } from "./helpers.js";

const original = process.env.VIVIC_REPLY_STYLE;
afterEach(() => {
  if (original === undefined) delete process.env.VIVIC_REPLY_STYLE;
  else process.env.VIVIC_REPLY_STYLE = original;
});

describe("reply style presets", () => {
  it("defaults to the warm/soft brand voice and appends it to both planner prompts", () => {
    delete process.env.VIVIC_REPLY_STYLE;
    expect(resolveReplyStyle()).toBe("warm");
    expect(replyStyleInstruction()).toContain("温柔");
    expect(buildSystemPrompt()).toContain("【语气】温柔");
    expect(buildToolSystemPrompt(emptyContext())).toContain("【语气】温柔");
  });

  it("normal keeps the raw prompts with no style block", () => {
    process.env.VIVIC_REPLY_STYLE = "normal";
    expect(resolveReplyStyle()).toBe("normal");
    expect(replyStyleInstruction()).toBe("");
    expect(buildSystemPrompt()).not.toContain("【语气】");
    expect(buildToolSystemPrompt(emptyContext())).not.toContain("【语气】");
  });

  it("retired and unknown values fall back to warm instead of disabling the voice", () => {
    for (const value of ["concise", "professional", "off", "something-else", ""]) {
      process.env.VIVIC_REPLY_STYLE = value;
      expect(resolveReplyStyle()).toBe("warm");
      expect(replyStyleInstruction()).toContain("温柔");
    }
  });
});
