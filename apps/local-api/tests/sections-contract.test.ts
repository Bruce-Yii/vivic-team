import { describe, expect, it } from "vitest";
import { flattenNoteSections, flattenSectionsProps } from "../src/cards/sections.js";
import type { Action } from "@vivic/contracts";

/**
 * `VIVIC_SECTIONS` is off by default: the deployed frontend only renders
 * text/bullets, so a structured note must be flattened before it leaves the
 * server. These cases pin that (no empty card window on the old renderer).
 */

const note = (props: Record<string, unknown>): Action => ({
  type: "card.create",
  card: { id: "note_1", type: "NoteCard", displayProps: props, sourceData: {},
    layout: { x: 0, y: 0, width: 340, height: 300 } } as unknown as Extract<Action, { type: "card.create" }>["card"],
});

describe("sections compatibility: flatten to text for the deployed frontend", () => {
  it("turns sections into the same readable text the template fallback produced", () => {
    const { props, flattened } = flattenSectionsProps({ sections: [
      { title: "议题", items: ["Q4 预算评审"] },
      { title: "结论", items: ["下周一定稿", "王经理跟进"] },
    ] });
    expect(flattened).toBe(true);
    expect(props.sections).toBeUndefined();
    expect(props.text).toBe("议题\n· Q4 预算评审\n\n结论\n· 下周一定稿\n· 王经理跟进");
  });

  it("leaves text/bullet notes untouched", () => {
    const plain = { text: "已有一句话便笺" };
    const { props, flattened } = flattenSectionsProps(plain);
    expect(flattened).toBe(false);
    expect(props).toBe(plain);
  });

  it("flattens every structured NoteCard in an action batch and keeps other actions", () => {
    const actions: Action[] = [note({ sections: [{ title: "议题", items: ["预算"] }] }),
      { type: "card.focus", targetId: "note_1" }];
    const next = flattenNoteSections(actions);
    const card = next[0] as Extract<Action, { type: "card.create" }>;
    expect(card.card.displayProps).toEqual({ text: "议题\n· 预算" });
    expect(next[1]).toEqual({ type: "card.focus", targetId: "note_1" });
  });

  it("is a no-op (same array) when nothing was structured", () => {
    const actions: Action[] = [{ type: "card.focus", targetId: "note_1" }];
    expect(flattenNoteSections(actions)).toBe(actions);
  });
});
