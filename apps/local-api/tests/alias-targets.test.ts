import { describe, expect, it } from "vitest";
import { equivalentTerms, matchKeysOf, namesCard, squash } from "../src/decision/aliases.js";
import { resolveTarget } from "../src/decision/target.js";
import type { CanvasContext } from "../src/schemas.js";

/**
 * The host resolves a target from the user's own words. A translation table is a
 * deterministic widening of "which name does this card answer to" — never a
 * decision about what to do with it (sc-15: 「Google 公司介绍」 vs 这张谷歌的卡片).
 */

const card = (id: string, title: string, type: string, x: number): CanvasContext["cards"][number] => ({
  id, type, aliases: [title], displayProps: { title }, sourceDataSummary: {},
  layout: { x, y: 0, width: 320, height: 120, pinned: false },
});

const canvas = (cards: CanvasContext["cards"], focus: string[] = []): CanvasContext => ({
  canvasId: "TEST-alias-targets", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 },
  focusHistory: focus, timeZone: "Asia/Shanghai", cards,
});

describe("alias keys", () => {
  it("squashes case, spaces and punctuation on both sides", () => {
    expect(squash("Google 公司介绍")).toBe("google公司介绍");
    expect(squash("「谷歌」的卡片")).toBe("谷歌的卡片");
    expect(squash("Apple Inc.")).toBe("appleinc");
  });

  it("lists the equivalent spellings of an entity a name mentions", () => {
    expect(equivalentTerms("Google 公司介绍")).toEqual(expect.arrayContaining(["谷歌", "google"]));
    expect(equivalentTerms("宁德时代")).toEqual(expect.arrayContaining(["catl", "宁德时代"]));
    // A name that mentions no known entity gains no translation.
    expect(equivalentTerms("会议记录")).toEqual([]);
  });

  it("drops keys shorter than two characters and empty names", () => {
    expect(matchKeysOf(["X", "", undefined, "谷歌"])).toEqual(["谷歌", "google", "alphabet"]);
  });

  it("matches 谷歌 to 「Google 公司介绍」 but not to an unrelated note", () => {
    expect(namesCard("这张谷歌的卡片讲了什么", ["Google 公司介绍"])).toBe(true);
    expect(namesCard("这张谷歌的卡片讲了什么", ["会议记录"])).toBe(false);
    expect(namesCard("讲讲苹果的发布会", ["Apple 秋季发布会"])).toBe(true);
    expect(namesCard("聚焦会议记录", ["Google 公司介绍"])).toBe(false);
  });
});

describe("resolveTarget with translations", () => {
  const context = canvas([card("note_meeting", "会议记录", "NoteCard", 0),
    card("answer_google", "Google 公司介绍", "NewsCard", 400)], ["note_meeting"]);

  it("resolves the translated name and reports the mechanism as an alias", async () => {
    const resolved = await resolveTarget("这张谷歌的卡片讲了什么", context, "focus");
    expect(resolved).toEqual({ targetId: "answer_google", source: "alias" });
  });

  it("still resolves the literal title as a title match", async () => {
    const resolved = await resolveTarget("聚焦会议记录", context, "focus");
    expect(resolved).toEqual({ targetId: "note_meeting", source: "title" });
  });

  it("keeps two same-entity cards a question instead of taking the focused one", async () => {
    const two = canvas([card("note_meeting", "会议记录", "NoteCard", 0),
      card("answer_google", "Google 公司介绍", "NewsCard", 400),
      card("answer_google2", "Google 广告业务", "NewsCard", 800)], ["note_meeting"]);
    const resolved = await resolveTarget("这张谷歌的卡片讲了什么", two, "focus");
    expect("ambiguous" in (resolved ?? {})).toBe(true);
    if (!resolved || !("ambiguous" in resolved)) return;
    expect(resolved.ambiguous.map(item => item.id).sort()).toEqual(["answer_google", "answer_google2"]);
  });
});
