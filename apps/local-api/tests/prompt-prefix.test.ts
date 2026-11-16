import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildToolSystemPrompt, TOOL_DEFINITIONS, TOOL_PROMPT_DYNAMIC_MARKER } from "../src/intent/toolCalls.js";
import type { CanvasContext } from "../src/schemas.js";

/**
 * Prompt-cache prefix stability.
 *
 * Providers can only reuse a *prefix*: the fixed instructions + tool schema must
 * be byte-identical for every request, and every per-request value (canvas id,
 * cards, focus, date, image hint) must live after it. These tests compute the
 * SHA-256 of the would-be cacheable prefix for different canvases and assert it
 * never changes, and that the image hint — which used to sit in the middle of
 * the rules — is now the last block.
 */

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const card = (id: string) => ({
  id, type: "NoteCard", aliases: [`卡片${id}`], displayProps: { text: `内容${id}` },
  sourceDataSummary: {}, layout: { x: 0, y: 0, width: 288, height: 160, pinned: false },
});

const context = (count: number, focusHistory: string[] = []): CanvasContext => ({
  canvasId: "TEST-prefix", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 },
  focusHistory, timeZone: "Asia/Shanghai",
  cards: Array.from({ length: count }, (_, index) => card(`card-${index}`)),
});

/** The fixed block is everything before the first per-request field. */
const fixedPrefix = (prompt: string): string => {
  const index = prompt.indexOf(TOOL_PROMPT_DYNAMIC_MARKER);
  expect(index, `dynamic marker missing from prompt: ${prompt.slice(0, 80)}`).toBeGreaterThan(0);
  return prompt.slice(0, index);
};

/** The full cacheable prefix: system instructions + serialized tool schema. */
const requestPrefix = (ctx: CanvasContext): string =>
  `${fixedPrefix(buildToolSystemPrompt(ctx))}\n${JSON.stringify(TOOL_DEFINITIONS)}`;

describe("tool prompt prefix stability", () => {
  it("hashes the same cacheable prefix for different canvas sizes and focus", () => {
    const hashes = [
      requestPrefix(context(0)),
      requestPrefix(context(3)),
      requestPrefix(context(27, ["card-2", "card-25"])),
    ].map(hash);
    expect(new Set(hashes).size).toBe(1);
  });

  it("keeps the image hint out of the fixed prefix", () => {
    const textPrefix = fixedPrefix(buildToolSystemPrompt(context(2)));
    const imagePrompt = buildToolSystemPrompt(context(2), { image: true });
    const imagePrefix = fixedPrefix(imagePrompt);
    expect(imagePrefix).toBe(textPrefix);
    expect(imagePrefix).not.toContain("本次请求带图");
    // Appended last, after the canvas facts.
    const tail = imagePrompt.slice(imagePrefix.length);
    expect(tail).toContain("画布卡片");
    expect(tail.indexOf("本次请求带图")).toBeGreaterThan(tail.indexOf("画布卡片"));
  });

  it("puts canvas id, cards, focus and the date after the fixed prefix", () => {
    const ctx = context(3, ["card-1"]);
    const prompt = buildToolSystemPrompt(ctx);
    const tail = prompt.slice(fixedPrefix(prompt).length);
    expect(tail).toContain(`canvasId=${ctx.canvasId}`);
    expect(tail).toContain("今天：");
    expect(tail).toContain("- card-0");
    expect(tail).toContain("[当前聚焦]");
    expect(tail).toContain("最近聚焦");
  });

  it("never embeds the user's sentence in the system prompt", () => {
    const prompt = buildToolSystemPrompt(context(2));
    for (const utterance of ["帮我记个便笺：明天交周报", "把右上角那张命名为项目复盘", "顺便提醒我带伞"]) {
      expect(prompt).not.toContain(utterance);
    }
  });
});
