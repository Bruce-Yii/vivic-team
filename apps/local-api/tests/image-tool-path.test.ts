import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewsCardSchema, type Action, type StoryCarouselCard } from "@vivic/contracts";
import { imageAnalysisContract, isTrustedImageRef } from "../src/cards/imageAnalysis.js";
import { CredentialStore } from "../src/credentials.js";
import { createHostedAssetService } from "../src/hosted/assets.js";
import { runIntent, type IntentRequest, type PipelineDeps } from "../src/intent/pipeline.js";
import { buildToolSystemPrompt, planFromToolCalls, type ToolCallPlan } from "../src/intent/toolCalls.js";
import type { CanvasContext } from "../src/schemas.js";
import { HostedSpaceStore } from "../src/space/store.js";
import type { StepfunResult } from "../src/stepfun.js";
import { testPng } from "./images.fixture.js";
import { withReceipt } from "./helpers.js";

/**
 * The image card on the model + tools path.
 *
 * The alternate slot planner used to be the only caller of
 * `cards/imageAnalysis.ts`, so an uploaded photo reached a NewsCard nowhere else.
 * These tests pin the restored path: the host persists the request's image, the
 * model may build an image-bearing card through `create_card`, and the host —
 * never the model — puts its own `media:image_<hash>` on that card. A model-named
 * image field is refused, and a reference that belongs to another account/space
 * cannot be committed.
 */

const NOW = Date.parse("2026-11-04T10:00:00+08:00");
const REF = `media:image_${"a".repeat(64)}`;
const attachment = () => ({ type: "image" as const, mime: "image/png" as const, data: testPng(2, 1, true).toString("base64") });

const canvas = (): CanvasContext => ({ canvasId: "TEST-image-tool-path", stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], timeZone: "Asia/Shanghai", cards: [] });

type Call = { name: string; arguments: Record<string, unknown> };
const plan = (calls: Call[], utterance: string, options: { trustedImageRef?: string } = {}): Promise<ToolCallPlan> =>
  planFromToolCalls(calls, canvas(), NOW, utterance, { ...options, sayFallback: true });

const creates = (result: ToolCallPlan): Array<Extract<Action, { type: "card.create" }>> =>
  result.actions.filter((action): action is Extract<Action, { type: "card.create" }> => action.type === "card.create");
const newsSummary = (data: Record<string, unknown> = {}): Call => ({ name: "create_card", arguments: { kind: "scene",
  fields: { scene_id: "news_summary", data: { headline: "蓝橙两块色彩", summary: "图片由左右两块颜色组成。",
    keyPoints: ["左侧是蓝色", "右侧是橙色"], ...data } } } });
const photoStory = (data: Record<string, unknown> = {}): Call => ({ name: "create_card", arguments: { kind: "scene",
  fields: { scene_id: "photo_story", data: { title: "蓝橙两块", slides: [{ heading: "左", text: "一块蓝色" },
    { heading: "右", text: "一块橙色", ...data }] } } } });

describe("create_card on an image request (host-owned picture)", () => {
  it("puts this request's media reference on the news_summary card and its answer variant", async () => {
    const summary = await plan([newsSummary()], "分析这张图片并整理成卡", { trustedImageRef: REF });
    expect(summary.kind).toBe("envelope");
    const [card] = creates(summary);
    expect(card!.card.type).toBe("NewsCard");
    const props = card!.card.displayProps as Record<string, unknown>;
    expect(props).toMatchObject({ headline: "蓝橙两块色彩", image: REF, summaryBy: "ai",
      keyPoints: ["左侧是蓝色", "右侧是橙色"] });
    expect(props).not.toHaveProperty("imageUrl");
    expect(NewsCardSchema.safeParse(card!.card).success).toBe(true);

    const answer = await plan([{ name: "create_card", arguments: { kind: "answer",
      fields: { title: "图片里有两种颜色", text: "左边蓝、右边橙。", points: ["蓝在左", "橙在右"] } } }],
    "这张图是什么", { trustedImageRef: REF });
    expect(answer.kind).toBe("envelope");
    expect((creates(answer)[0]!.card.displayProps as Record<string, unknown>))
      .toMatchObject({ headline: "图片里有两种颜色", image: REF, summaryBy: "ai" });
  });

  it("attaches the same reference to the photo_story slides through their own builder", async () => {
    const result = await plan([photoStory()], "把这张图讲成两段", { trustedImageRef: REF });
    expect(result.kind).toBe("envelope");
    const card = creates(result)[0]!.card;
    expect(card.type).toBe("StoryCarouselCard");
    const slides = (card.displayProps as StoryCarouselCard["displayProps"]).slides;
    expect(slides.map(slide => slide.image)).toEqual([REF, REF]);
    expect(slides.map(slide => slide.text)).toEqual(["一块蓝色", "一块橙色"]);
  });

  it("refuses a model-named image instead of silently keeping or replacing it", async () => {
    const refused = await plan([newsSummary({ imageUrl: "https://unit.test/model.png" })], "分析这张图", { trustedImageRef: REF });
    expect(refused.kind).toBe("invalid");
    expect(refused.actions).toEqual([]);
    expect(refused.issues.join(" | ")).toContain("imageUrl");
    expect(refused.issues.join(" | ")).toContain("宿主注入");

    const slides = await plan([photoStory({ imageUrl: "https://unit.test/model.png" })], "把这张图讲成两段", { trustedImageRef: REF });
    expect(slides.kind).toBe("invalid");
    expect(slides.issues.join(" | ")).toContain("slides 的 imageUrl");

    // A media reference the model invented is not a valid image value either: the
    // scene payload only accepts https links, so it fails before any card exists.
    const invented = `media:image_${"b".repeat(64)}`;
    const media = await plan([newsSummary({ imageUrl: invented })], "分析这张图", { trustedImageRef: REF });
    expect(media.kind).toBe("invalid");
    expect(media.actions).toEqual([]);
    expect(media.issues.length).toBeGreaterThan(0);
    for (const action of creates(media)) expect(JSON.stringify(action.card)).not.toContain(invented);

    // The refusal is actionable: the same call without the image field builds
    // the card, and only the host reference is on it.
    const repaired = await plan([newsSummary()], "分析这张图", { trustedImageRef: REF });
    expect(repaired.kind).toBe("envelope");
    expect((creates(repaired)[0]!.card.displayProps as Record<string, unknown>).image).toBe(REF);
  });

  it("never shows the media reference to the model: it only exists in the host prompt contract", () => {
    const prompt = buildToolSystemPrompt(canvas(), { image: true });
    expect(prompt).toContain("本次请求带图");
    expect(prompt).toContain("imageUrl");
    expect(prompt).not.toContain(REF);
    expect(prompt).not.toContain("media:");
  });

  it("does not force a card when the model only answers with text", async () => {
    const chat = await plan([{ name: "chat", arguments: {} }], "你好", { trustedImageRef: REF });
    expect(chat.kind).toBe("chat");
    expect(chat.actions).toEqual([]);
    expect(creates(chat)).toEqual([]);
    const unsupported = await plan([{ name: "unsupported", arguments: { reply: "我没法替你打电话" } }],
      "帮我打个电话", { trustedImageRef: REF });
    // A spoken line is the whole effect: no image card is invented for it.
    expect(creates(unsupported)).toEqual([]);
    expect(unsupported.actions.every(action => action.type === "subtitle.show")).toBe(true);
  });
});

describe("requests without an image are untouched", () => {
  it("builds the same cards with no image field when the host has no reference", async () => {
    const answer = await plan([{ name: "create_card", arguments: { kind: "answer",
      fields: { title: "光合作用", text: "植物把光能转成化学能。" } } }], "解释一下光合作用");
    expect(answer.kind).toBe("envelope");
    expect(creates(answer)[0]!.card.displayProps).not.toHaveProperty("image");

    const story = await plan([photoStory()], "把这张图讲成两段");
    expect(story.kind).toBe("envelope");
    const slides = (creates(story)[0]!.card.displayProps as StoryCarouselCard["displayProps"]).slides;
    expect(slides.every(slide => slide.image === undefined)).toBe(true);

    const prompt = buildToolSystemPrompt(canvas());
    expect(prompt).not.toContain("本次请求带图");
  });

  it("ignores a reference that is not this request's persisted media (https, file, empty)", async () => {
    for (const ref of ["https://unit.test/TEST.png", `media:file_${"a".repeat(64)}`, "media:image_short"]) {
      expect(isTrustedImageRef(ref)).toBe(false);
      const result = await plan([{ name: "create_card", arguments: { kind: "answer",
        fields: { title: "标题", text: "一段回答" } } }], "解释一下", { trustedImageRef: ref });
      expect(result.kind).toBe("envelope");
      expect(creates(result)[0]!.card.displayProps).not.toHaveProperty("image");
    }
    expect(isTrustedImageRef(REF)).toBe(true);
    expect(imageAnalysisContract.slots.safeParse({ headline: "主题", summary: "摘要" }).success).toBe(true);
  });
});

/* -------------------------------------------------------------- pipeline */

type ToolRequest = { messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }> };

function setup(calls: Call[]): { deps: PipelineDeps; toolRequests: ToolRequest[]; generate: ReturnType<typeof vi.fn> } {
  const toolRequests: ToolRequest[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    toolRequests.push(JSON.parse(String(init?.body)) as ToolRequest);
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: withReceipt(calls).map((call, index) => ({
      index, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    })) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const generate = vi.fn(async (): Promise<StepfunResult<unknown>> => ({ ok: true, value: { reply: "planner answered" } }));
  const deps: PipelineDeps = { credentials: new CredentialStore(),
    stepfun: { baseUrl: "https://tools.invalid/v1", fetchImpl: fetchImpl as unknown as typeof fetch },
    planner: { provider: "deepseek", connected: true, isCurrent: () => true, generate },
    mainProvider: "deepseek", toolCalls: true,
    toolCredential: { apiKey: "TEST-image-tool-key", models: ["vision-model"], defaultModel: "vision-model",
      checkedAt: new Date().toISOString() } };
  return { deps, toolRequests, generate };
}

const intent = (extra: Partial<IntentRequest> = {}): IntentRequest => ({ text: "分析这张图片，整理成一张资讯卡",
  canvasContext: canvas(), attachments: [attachment()], trustedImageRef: REF, ...extra });

describe("pipeline: the tool turn is the path for a persisted image", () => {
  it("forwards the image to the model and commits a NewsCard with the host reference only", async () => {
    const f = setup([newsSummary()]);
    const result = await runIntent(intent(), f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.toolCalls).toBe(true);
    expect(f.generate).not.toHaveBeenCalled();
    const card = result.envelope!.actions.find(action => action.type === "card.create");
    if (!card || card.type !== "card.create") throw new Error("TEST expected a created card");
    expect(NewsCardSchema.parse(card.card).displayProps.image).toBe(REF);

    expect(f.toolRequests).toHaveLength(1);
    const request = f.toolRequests[0]!;
    const user = request.messages.find(message => message.role === "user")!;
    expect(Array.isArray(user.content)).toBe(true);
    const parts = user.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts.filter(part => part.type === "image_url").map(part => part.image_url!.url))
      .toEqual([`data:image/png;base64,${attachment().data}`]);
    expect(parts.find(part => part.type === "text")?.text).toBe(intent().text);
    // The model must not receive the reference it could copy into a card.
    expect(JSON.stringify(request)).not.toContain(REF);
    expect(JSON.stringify(request)).not.toContain("media:image_");
  });

  it("does not use the tool turn when the request carries no host reference", async () => {
    const f = setup([newsSummary()]);
    const result = await runIntent(intent({ trustedImageRef: undefined }), f.deps);
    // The vision planner keeps the old shape; the tool surface is never offered
    // an image it could not annotate.
    expect(result.kind).not.toBe("error");
    expect(f.toolRequests).toEqual([]);
    expect(f.generate).toHaveBeenCalled();
  });

  it("never injects a reference the host did not persist for this request (no attachment)", async () => {
    const f = setup([{ name: "create_card", arguments: { kind: "answer",
      fields: { title: "一张图片", text: "这里没有图片字节。" } } }]);
    const result = await runIntent(intent({ text: "解释一下这张图片", attachments: undefined }), f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    const card = result.envelope!.actions.find(action => action.type === "card.create");
    if (!card || card.type !== "card.create") throw new Error("TEST expected an answer card");
    expect(card.card.displayProps).not.toHaveProperty("image");
    expect(f.toolRequests).toHaveLength(1);
    expect(JSON.stringify(f.toolRequests[0])).not.toContain("image_url");
    expect(JSON.stringify(f.toolRequests[0])).not.toContain(REF);
  });

  it("keeps image turns on a GPT planner: that model's vision was the one checked", async () => {
    const f = setup([newsSummary()]);
    const generate = f.generate as unknown as NonNullable<PipelineDeps["planner"]>["generate"];
    const gpt: PipelineDeps = { ...f.deps, planner: { provider: "gpt", connected: true, isCurrent: () => true, generate } };
    const result = await runIntent(intent(), gpt);
    expect(result.kind, JSON.stringify(result)).not.toBe("error");
    expect(f.toolRequests).toEqual([]);
    expect(f.generate).toHaveBeenCalled();
  });
});

/* ----------------------------------------------------- account boundary */

const stores: HostedSpaceStore[] = [], folders: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.dispose();
  for (const folder of folders.splice(0)) fs.rmSync(fs.realpathSync(folder), { recursive: true, force: true });
});

describe("a reference from another account or space cannot be committed", () => {
  it("accepts the card only in the account/space that uploaded the image", async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "vivic-image-tool-path-")); folders.push(dir);
    const store = new HostedSpaceStore({ dataDir: dir, inviteCode: "test-image-tool-invite" }); stores.push(store);
    const { identity } = await store.register({ invite: "test-image-tool-invite", username: "test_image_tool", password: "test-image-tool-password" });
    const accountId = identity.accountId, deviceId = identity.device.id, spaceId = store.listSpaces(accountId)[0]!.id;
    const assets = createHostedAssetService({ store, dataDir: dir });
    const ref = await assets.persistIntentImage(accountId, spaceId, attachment(), deviceId);
    expect(isTrustedImageRef(ref)).toBe(true);

    const planned = await plan([newsSummary()], "分析这张图", { trustedImageRef: ref });
    expect(planned.kind).toBe("envelope");
    const actions = planned.actions;
    const apply = (owner: string, space: string, ownerDevice: string) => {
      const requestId = randomUUID();
      return store.applyEnvelope(owner, space, { requestId, expectedVersion: store.getSnapshot(owner, space).space.version,
        envelope: { schemaVersion: "0.6", requestId, canvasId: space, actions } }, ownerDevice);
    };
    expect(apply(accountId, spaceId, deviceId).snapshot.space.cards).toHaveLength(1);
    // The uploading account's own other space does not inherit the blob either.
    const otherOwnSpace = store.createSpace(accountId, { title: "TEST second space", requestId: randomUUID() }, deviceId).space.id;
    expect(() => apply(accountId, otherOwnSpace, deviceId)).toThrow();

    // A second account (same deployment dir, own invitation) has no such asset:
    // the exact same envelope must be refused.
    store.dispose();
    const second = new HostedSpaceStore({ dataDir: dir, inviteCode: "test-image-tool-second" }); stores.push(second);
    const other = await second.register({ invite: "test-image-tool-second", username: "test_image_other", password: "test-image-tool-password" });
    const otherSpace = second.listSpaces(other.identity.accountId)[0]!.id;
    const requestId = randomUUID();
    expect(() => second.applyEnvelope(other.identity.accountId, otherSpace, { requestId, expectedVersion: 0,
      envelope: { schemaVersion: "0.6", requestId, canvasId: otherSpace, actions } }, other.identity.device.id))
      .toThrow();
    expect(second.getSnapshot(other.identity.accountId, otherSpace).space.cards).toEqual([]);
  });
});
