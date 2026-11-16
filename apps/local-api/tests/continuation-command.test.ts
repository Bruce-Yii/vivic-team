import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionEnvelopeSchema, NoteCardSchema, type IntentRouteId } from "@vivic/contracts";
import { classifyContinuation, isNewCommand } from "../src/decision/continuation.js";
import { DecisionTaskManager, type TaskRunDeps } from "../src/decision/taskV2.js";
import { CredentialStore } from "../src/credentials.js";
import { HostedSpaceStore } from "../src/space/store.js";
import { createHostedTaskService, type HostedTaskRecord } from "../src/hosted/tasks.js";
import { runIntent, type IntentRequest, type IntentResult, type PipelineDeps } from "../src/intent/pipeline.js";
import type { CanvasContext } from "../src/schemas.js";

const row = (id: string, text: string, x: number): CanvasContext["cards"][number] => ({ id, type: "NoteCard",
  displayProps: { text }, sourceDataSummary: {}, layout: { x, y: 0, width: 320, height: 120, pinned: false } });
const context = (): CanvasContext => ({ canvasId: "TEST-continuation", version: 3, stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [row("TEST-note-1", "读书笔记", 0), row("TEST-note-2", "会议记录", 400)] });

const managers: DecisionTaskManager[] = [];
afterEach(() => { for (const tasks of managers.splice(0)) tasks.dispose(); vi.restoreAllMocks(); });
const manager = () => { const tasks = new DecisionTaskManager(); managers.push(tasks); return tasks; };

const proposal = (request: IntentRequest): IntentResult => ({ kind: "envelope", usedProvider: "rules",
  envelope: ActionEnvelopeSchema.parse({ schemaVersion: "0.6", requestId: `TEST-${randomUUID()}`,
    canvasId: request.canvasContext.canvasId, actions: [{ type: "card.focus", targetId: "TEST-note-1" }] }) });
const ambiguous = (): IntentResult => ({ kind: "clarify", message: "你要操作哪一张？",
  targetCandidates: [{ id: "TEST-note-1", label: "读书笔记" }, { id: "TEST-note-2", label: "会议记录" }], targetClause: 0 });

describe("continuation classifier", () => {
  it.each([
    "把刚才那张卡往右移一点", "把刚才创建的卡片固定住", "自动整理一下画布", "暂停那个倒计时", "继续刚才的倒计时",
    "把刚才那张会议纪要删了", "加个提醒：明天开会", "帮我建个待办", "撤销", "重做", "显示全部", "恢复原视图",
    "往右移一点", "刚才那张卡往右移一点",
    // Card/record nouns open a new card even without an imperative verb.
    "书籍记录：《原则》瑞·达利欧，已读完，评分4.5", "做11月日历：11月5日开会、11月12日体检",
    "帮我记一下书籍记录：《原则》，读完，评分4.5", "目标进度：今年读书12本，已完成9本",
  ])("treats %s as a new command", text => {
    expect(classifyContinuation(text)).toBe("new-command");
    expect(isNewCommand(text)).toBe(true);
  });

  it.each([
    "1", "2号", "第二张", "第三个", "用第2个", "帮我选第二张", "是的", "不是", "好", "算了不要了", "不要",
    // B6 / B19 answers contain no command shape and stay answers.
    "三条：AI芯片英伟达Rubin，开源模型Llama4，手机Mate70",
    "三条分别是：1）AI芯片——英伟达发布Rubin架构，来源官方发布会；2）开源模型——Meta开源Llama4；3）手机新品——华为Mate70。",
    "海边日落，山顶云海，咖啡馆拿铁，夜景灯光",
    // A duration is the answer to "delete which timer?", not a new countdown.
    "五分钟倒计时", "十五分钟后",
    // Mixed/mutated sentence keeps the old answer path (see clarification tests).
    "上海天气然后删除旧卡", "周一3，周二5，周三4",
    "购物待办", "待办：买牛奶",
  ])("treats %s as an answer", text => {
    expect(classifyContinuation(text)).toBe("answer");
    expect(isNewCommand(text)).toBe(false);
  });

  it("keeps an exact frozen candidate label an answer even when it reads like a command", () => {
    expect(isNewCommand("删除全部卡片")).toBe(true);
    expect(classifyContinuation("删除全部卡片", { choices: ["删除全部卡片", "会议记录"] })).toBe("answer");
    // Only the whole label counts: naming the candidate inside a command is still a command.
    expect(isNewCommand("把删除全部卡片固定住", { choices: ["删除全部卡片"] })).toBe(true);
  });
});

// B13/B14 live regression: a habit check-in follow-up is pending, then the user
// starts a different card. Both were swallowed as answers and re-asked the habit
// question; the classifier now sees the card noun / the unrelated payload.
describe("new topic inside a pending habit clarification (B13/B14)", () => {
  const habit = { previousUtterance: "习惯打卡：每天背单词，本周一到周三做到了",
    question: "打卡要具体到日期：这周哪几天打了卡？" };

  it.each([
    "书籍记录：《原则》瑞·达利欧，已读完，评分4.5",
    "做11月日历：11月5日开会、11月12日体检",
    "帮我记一下书籍记录：《原则》，读完，评分4.5",
    "运动记录：今天跑步5公里，配速6分30秒",
    "明天下午三点在国贸三期和客户开会讨论下一季度合同的全部细节",
  ])("treats %s as a new command, not an answer", text => {
    expect(classifyContinuation(text, habit)).toBe("new-command");
    expect(isNewCommand(text, habit)).toBe(true);
  });

  it.each([
    // B6/B19 supplements stay answers: the filler lead or the short-item list
    // keeps them, even when they are long and share no keyword with the question.
    "三条：AI芯片英伟达Rubin，开源模型Llama4，手机Mate70",
    "三条分别是：1）AI芯片——英伟达发布Rubin架构，来源官方发布会；2）开源模型——Meta开源Llama4；3）手机新品——华为Mate70。",
    "海边日落，山顶云海，咖啡馆拿铁，夜景灯光",
    "海边日落，山顶云海，咖啡馆拿铁，夜景灯光，老街建筑",
    // A date-only reply is still the answer to "哪几天".
    "11月5日和11月12日",
    // A long reply that reuses the question's words is a supplement, not a new topic.
    "这周一到周三我每天都背了单词一共三天都打了卡",
  ])("keeps the supplement %s an answer", text => {
    expect(classifyContinuation(text, habit)).toBe("answer");
    expect(isNewCommand(text, habit)).toBe(false);
  });

  it.each(["1", "第二张", "用第2个", "是的", "不是"])("keeps the short reply %s an answer", text => {
    expect(classifyContinuation(text, habit)).toBe("answer");
    expect(isNewCommand(text, habit)).toBe(false);
  });

  it("keeps a candidate label an answer even while a habit question is pending", () => {
    expect(classifyContinuation("书籍记录", { ...habit, choices: ["书籍记录", "习惯打卡"] })).toBe("answer");
  });
});

describe("task manager clarification vs new command", () => {
  it("runs the new command instead of answering the old question, and never duplicates the step", async () => {
    const tasks = manager();
    const legacy = vi.fn(async (request: IntentRequest) => request.text === "把刚才那张卡固定住" && !request.resolvedTargetId && !request.resolvedTargets ? ambiguous() : proposal(request));
    const deps: TaskRunDeps = { legacy, safetyMode: true };
    const first = await tasks.run({ text: "把刚才那张卡固定住", canvasContext: context() }, deps);
    expect(first.kind).toBe("clarify");
    expect(first.task?.clarification?.candidates.map(candidate => candidate.id)).toEqual(["TEST-note-1", "TEST-note-2"]);

    const second = await tasks.run({ text: "把刚才那张卡往右移一点", canvasContext: context(), task: { id: first.task!.id } }, deps);
    expect(second.kind).toBe("envelope");
    expect(second.message ?? "").not.toContain("请用原候选");
    expect(second.task?.status).toBe("awaiting_execution");
    const calls = legacy.mock.calls.map(([request]) => request as IntentRequest);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.text).toBe("把刚才那张卡往右移一点");
    expect(calls[1]!.continuation).toBeUndefined();

    const repeat = await tasks.run({ text: "把刚才那张卡往右移一点", canvasContext: context(), task: { id: first.task!.id } }, deps);
    expect(repeat.task?.executionId).toBe(second.task?.executionId);
    expect(legacy).toHaveBeenCalledTimes(2);
  });

  it.each([["1", "TEST-note-1"], ["第二张", "TEST-note-2"], ["2号", "TEST-note-2"]])(
    "keeps the ordinal reply %s on the frozen candidate path", async (text, targetId) => {
      const tasks = manager();
      const legacy = vi.fn(async (request: IntentRequest) => request.text === "把刚才那张卡固定住" && !request.resolvedTargetId && !request.resolvedTargets ? ambiguous() : proposal(request));
      const deps: TaskRunDeps = { legacy, safetyMode: true };
      const first = await tasks.run({ text: "把刚才那张卡固定住", canvasContext: context() }, deps);
      const answer = await tasks.run({ text, canvasContext: context(), task: { id: first.task!.id } }, deps);
      expect(answer.kind).toBe("envelope");
      const calls = legacy.mock.calls.map(([request]) => request as IntentRequest);
      expect(calls).toHaveLength(2);
      // The original goal is replayed with the frozen target, not the ordinal text.
      expect(calls[1]!.text).toBe("把刚才那张卡固定住");
      expect(calls[1]!.resolvedTargetId).toBe(targetId);
    });

  it.each(["是的", "不是"])("does not start a new task for the %s reply", async text => {
    const tasks = manager();
    const legacy = vi.fn(async (request: IntentRequest) => request.text === "把刚才那张卡固定住" && !request.resolvedTargetId && !request.resolvedTargets ? ambiguous() : proposal(request));
    const deps: TaskRunDeps = { legacy, safetyMode: true };
    const first = await tasks.run({ text: "把刚才那张卡固定住", canvasContext: context() }, deps);
    const answer = await tasks.run({ text, canvasContext: context(), task: { id: first.task!.id } }, deps);
    expect(answer.kind).toBe("clarify");
    expect(answer.message).toContain("请用原候选的编号或完整标题选择");
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("keeps a B6-style supplement on the clarification answer path", async () => {
    const original = "整理三条科技新闻：AI芯片发布、开源模型更新、手机新品";
    const supplement = "三条：AI芯片英伟达Rubin，开源模型Llama4，手机Mate70";
    const tasks = manager();
    const legacy = vi.fn(async (request: IntentRequest) => request.text === original
      ? { kind: "clarify" as const, message: "新闻卡需要标题和摘要，请给每条的关键信息。" }
      : proposal(request));
    const deps: TaskRunDeps = { legacy };
    const first = await tasks.run({ text: original, canvasContext: context() }, deps);
    expect(first.kind).toBe("clarify");
    const answer = await tasks.run({ text: supplement, canvasContext: context(), task: { id: first.task!.id } }, deps);
    expect(answer.kind).toBe("envelope");
    const calls = legacy.mock.calls.map(([request]) => request as IntentRequest);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.text).toBe(supplement);
    expect(calls[1]!.continuation?.utterance).toBe(original);
    expect(calls[1]!.continuation?.question).toBe("新闻卡需要标题和摘要，请给每条的关键信息。");
  });

  it.each([
    "书籍记录：《原则》瑞·达利欧，已读完，评分4.5",
    "做11月日历：11月5日开会、11月12日体检",
  ])("abandons a pending habit question when the next turn is %s", async text => {
    const habit = "习惯打卡：每天背单词，本周一到周三做到了";
    const tasks = manager();
    const legacy = vi.fn(async (request: IntentRequest) => request.text === habit
      ? { kind: "clarify" as const, message: "打卡要具体到日期：这周哪几天打了卡？" }
      : proposal(request));
    const deps: TaskRunDeps = { legacy };
    const first = await tasks.run({ text: habit, canvasContext: context() }, deps);
    expect(first.kind).toBe("clarify");
    expect(first.task?.status).toBe("awaiting_clarification");

    const next = await tasks.run({ text, canvasContext: context(), task: { id: first.task!.id } }, deps);
    expect(next.kind).toBe("envelope");
    expect(next.task?.status).toBe("awaiting_execution");
    const calls = legacy.mock.calls.map(([request]) => request as IntentRequest);
    expect(calls).toHaveLength(2);
    // The old habit question is not replayed: the new card runs on its own words.
    expect(calls[1]!.text).toBe(text);
    expect(calls[1]!.continuation).toBeUndefined();
  });
});

const folders: string[] = [], disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  for (const folder of folders.splice(0)) {
    const absolute = realpathSync(folder);
    expect(path.dirname(absolute)).toBe(realpathSync(tmpdir()));
    expect(path.basename(absolute)).toMatch(/^vivic-continuation-/);
    rmSync(absolute, { recursive: true, force: true });
  }
});

function hostedCard() {
  return NoteCardSchema.parse({ id: `note_${randomUUID()}`, type: "NoteCard", variant: "minimal", sources: [], sourceData: {},
    displayProps: { text: "TEST hosted note" }, layout: { x: 0, y: 0, width: 320, height: 200, pinned: false },
    metadata: { createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z" } });
}

async function hostedFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "vivic-continuation-")); folders.push(dir);
  const store = new HostedSpaceStore({ dataDir: dir, inviteCode: "TEST-continuation-invitation" });
  const { identity } = await store.register({ invite: "TEST-continuation-invitation", username: "test_continuation", password: "TEST-continuation-password" });
  const accountId = identity.accountId, spaceId = store.listSpaces(accountId)[0]!.id;
  const calls: IntentRequest[] = [];
  const invoke = vi.fn(async (_accountId: string, _route: string, body: unknown) => {
    const request = structuredClone(body as IntentRequest); calls.push(request);
    if (request.text === "记录一条便笺") return Response.json({ kind: "clarify", message: "便笺写什么？" } satisfies IntentResult);
    if (request.text === "习惯打卡：每天背单词，本周一到周三做到了")
      return Response.json({ kind: "clarify", message: "打卡要具体到日期：这周哪几天打了卡？" } satisfies IntentResult);
    const card = hostedCard();
    return Response.json({ kind: "envelope", envelope: ActionEnvelopeSchema.parse({ schemaVersion: "0.6",
      requestId: randomUUID(), canvasId: request.canvasContext.canvasId, actions: [{ type: "card.create", card }] }) } satisfies IntentResult);
  });
  const service = createHostedTaskService({ store, invoke });
  disposals.push(async () => { await service.dispose(); store.dispose(); });
  const read = (id: string) => store.getAccountValue<HostedTaskRecord>(accountId, `task:${spaceId}:${id}`)!;
  const start = (requestId: string, text: string, continuationTaskId?: string) => service.handle(new Request(
    `https://unit.test/api/space/spaces/${spaceId}/tasks`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, text, expectedVersion: store.getSnapshot(accountId, spaceId).space.version,
        ...(continuationTaskId ? { continuationTaskId } : {}) }) }), identity);
  const wait = async (id: string) => { await vi.waitFor(() => expect(service.activeCount()).toBe(0)); return read(id); };
  return { calls, read, start, wait };
}

describe("hosted task continuation vs new command", () => {
  it("starts a fresh task for the new command and cancels the old question", async () => {
    const f = await hostedFixture();
    expect((await f.start("question", "记录一条便笺"))!.status).toBe(202);
    expect((await f.wait("question")).status).toBe("awaiting_clarification");
    expect((await f.start("move", "把刚才那张卡往右移一点", "question"))!.status).toBe(202);
    const task = await f.wait("move");
    expect(task.status).toBe("succeeded");
    const previous = f.read("question");
    expect(previous.status).toBe("cancelled");
    expect(previous.message).toContain("已放弃上一个问题");
    expect(task.turns?.map(turn => turn.text)).toEqual(["把刚才那张卡往右移一点"]);
    expect(task.executions).toHaveLength(1);
    expect(task.createdCardIds).toHaveLength(1);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.text).toBe("把刚才那张卡往右移一点");
    expect(f.calls[1]!.task?.id).toBe("move");
    expect(f.calls[1]!.continuation).toBeUndefined();
    expect(f.calls[1]!.task?.receipt).toBeUndefined();
  });

  it.each([
    "书籍记录：《原则》瑞·达利欧，已读完，评分4.5",
    "做11月日历：11月5日开会、11月12日体检",
  ])("starts a fresh task for the different card %s during a habit follow-up", async text => {
    const habit = "习惯打卡：每天背单词，本周一到周三做到了";
    const f = await hostedFixture();
    expect((await f.start("habit", habit))!.status).toBe(202);
    expect((await f.wait("habit")).status).toBe("awaiting_clarification");
    expect((await f.start("b13", text, "habit"))!.status).toBe(202);
    const task = await f.wait("b13");
    expect(task.status).toBe("succeeded");
    expect(f.read("habit").status).toBe("cancelled");
    expect(f.read("habit").message).toContain("已放弃上一个问题");
    // The habit question is not inherited: one turn, no continuation, one card.
    expect(task.turns?.map(turn => turn.text)).toEqual([text]);
    expect(f.calls[1]!.text).toBe(text);
    expect(f.calls[1]!.continuation).toBeUndefined();
  });

  it("keeps a genuine answer linked to the old question", async () => {
    const f = await hostedFixture();
    expect((await f.start("question2", "记录一条便笺"))!.status).toBe(202);
    expect((await f.wait("question2")).status).toBe("awaiting_clarification");
    expect((await f.start("answer2", "便笺写什么：买咖啡", "question2"))!.status).toBe(202);
    const task = await f.wait("answer2");
    expect(task.status).toBe("succeeded");
    expect(f.read("question2").message).toContain("已通过后续答复继续此问题");
    // A linked answer reuses the original business task id and keeps both turns.
    expect(f.calls[1]!.text).toBe("便笺写什么：买咖啡");
    expect(f.calls[1]!.task?.id).toBe("question2");
    expect(task.turns?.map(turn => turn.text)).toEqual(["记录一条便笺", "便笺写什么：买咖啡"]);
    expect(task.turns?.[1]?.question).toBe("便笺写什么？");
  });

  it("does not reject a new command because the linked task already finished", async () => {
    const f = await hostedFixture();
    expect((await f.start("done", "整理画布"))!.status).toBe(202);
    expect((await f.wait("done")).status).toBe("succeeded");
    expect((await f.start("fresh", "帮我把卡片往左移一点", "done"))!.status).toBe(202);
    const task = await f.wait("fresh");
    expect(task.status).toBe("succeeded");
    expect(f.read("done").status).toBe("succeeded");
    expect(f.calls.at(-1)!.text).toBe("帮我把卡片往左移一点");
  });
});
