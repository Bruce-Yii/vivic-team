import { describe, expect, it, vi } from "vitest";
import { feedbackReader, withoutFeedback } from "../src/intent/feedback.js";
import { runIntent, type PipelineDeps } from "../src/intent/pipeline.js";
import { CredentialStore } from "../src/credentials.js";
import { emptyContext } from "./helpers.js";
import { createApp } from "../src/app.js";
import { authed, testConfig } from "./helpers.js";

describe("same-call feedback metadata", () => {
  it("decodes escaped quotes and unicode across every possible split without exposing slots", () => {
    const content = JSON.stringify({ feedback: '我来整理“阅读”材料。', slots: { text: "内部字段" } });
    for (let cut = 0; cut <= content.length; cut++) {
      const publish = vi.fn(), read = feedbackReader(publish);
      read(content.slice(0, cut)); read(content.slice(cut));
      expect(publish.mock.calls).toEqual([['我来整理“阅读”材料。']]);
    }
    const publish = vi.fn(), read = feedbackReader(publish);
    for (const character of '{"feedback":"我来整理\\u201c阅读\\u201d材料。","slots":{}}') read(character);
    expect(publish).toHaveBeenCalledWith('我来整理“阅读”材料。');
  });
  it.each([
    '{"slots":{},"feedback":"我来整理。"}', '{"feedback":"已创建卡片。"}', '{"feedback":"便笺创建好了，计时也设好了。"}', '{"feedback":"tools.cards.todo({})"}',
    '{"feedback":"我来整理', '{"feedback": {"text":"不能透传"}}', '{"say":"最终文案"}',
    '{"feedback":"card.create targetId=note_123"}', '{"feedback":"我来写入NoteCard的displayProps。"}',
  ])("does not publish unsafe, incomplete or late fields: %s", content => {
    const publish = vi.fn(); feedbackReader(publish)(content); expect(publish).not.toHaveBeenCalled();
  });
  it.each([
    "已为你创建卡片。", "已帮你生成内容。", "我帮你弄好了。", "做好了。", "搞定了。",
    "卡片弄好了，请查看。", "我创建了卡片。", "已删除卡片。", "已设置提醒。",
  ])("rejects a finished-state first sentence even without an adjacent 已: %s", text => {
    const publish = vi.fn(); feedbackReader(publish)(JSON.stringify({ feedback: text })); expect(publish).not.toHaveBeenCalled();
  });
  it.each([
    "正在创建卡片。", "正在为你创建卡片。", "正在整理这张卡。", "我会帮你创建。", "我先看看。", "我来整理一下。",
  ])("keeps an honest in-progress first sentence: %s", text => {
    const publish = vi.fn(); feedbackReader(publish)(JSON.stringify({ feedback: text })); expect(publish).toHaveBeenCalledWith(text);
  });
  it("leaves the existing output contract intact", () => {
    expect(withoutFeedback({ feedback: "我来整理。", slots: { text: "原文" } })).toEqual({ slots: { text: "原文" } });
  });
  it("starts a clean prefix for a provider retry after an incomplete string", () => {
    const publish = vi.fn(), read = feedbackReader(publish);
    read('{"feedback":"我来'); read.reset(); read('{"feedback":"我来整理内容。","slots":{}}');
    expect(publish.mock.calls).toEqual([["我来整理内容。"]]);
  });
});
