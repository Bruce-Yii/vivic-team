import { describe, expect, it } from "vitest";
import { classifyIntent, looksLikeSelfEcho } from "../turnTaking";

/**
 * Regression guard for self-echo barge-in.
 *
 * Measured on real TTS → real ASR → real classifier: 3 of 12 assistant lines
 * (25%) mapped to new_constraint / cancel_task and would have interrupted the
 * assistant on its own words. The guard must block exactly those, while still
 * honouring a genuine user barge-in during playback.
 */

const ASSISTANT_LINES = [
  "好的，已经为你创建下午三点的会议提醒。",
  "我再确认一下，不过这个时间和你之前的安排有冲突。",
  "另外还有两张卡片没有保存，需要我一起处理吗？",
  "已经取消这个限购提醒，其他内容保持不变。",
  "你可以继续说，我会在后台把结果整理成卡片。",
  "正在查询明天上海的天气，请稍等。",
  "提醒已经设置好了，需要我再说一遍吗？",
  "这个任务需要三个步骤，目前完成第一步。",
  "如果你不确定，我可以先不做修改。",
  "抱歉，我没有听清，你能再说一次吗？",
  "今天一共创建了四张卡片。",
  "好的，已经切换到设计讨论这个空间。",
];

describe("assistant self-echo is not a user turn", () => {
  it.each(ASSISTANT_LINES)("blocks the assistant's own line: %s", (line) => {
    // Echo transcribes with light normalisation (number formatting, punctuation).
    const heard = line.replace("四张", "4 张");
    expect(looksLikeSelfEcho(heard, line)).toBe(true);
  });

  it("would have interrupted on 3 of these lines without the guard", () => {
    const interrupting = ASSISTANT_LINES.filter((line) => ["stop", "cancel_task", "new_constraint", "new_topic"].includes(classifyIntent(line)));
    expect(interrupting).toHaveLength(3);
  });
});

describe("a genuine barge-in still gets through", () => {
  const playing = "明天下午三点提醒你开会，到时候我会提前十分钟通知你。";

  it.each(["停", "停一下", "等一下", "不对", "我说的是后天", "取消", "换个话题"])(
    "does not mistake a short real interruption for echo: %s", (heard) => {
      expect(looksLikeSelfEcho(heard, playing)).toBe(false);
    });

  it("does not mistake an unrelated user sentence for echo", () => {
    expect(looksLikeSelfEcho("帮我建一张关于旅行的卡片", playing)).toBe(false);
  });

  it("ignores the guard when nothing is being spoken", () => {
    expect(looksLikeSelfEcho("明天下午三点提醒我开会", null)).toBe(false);
    expect(looksLikeSelfEcho("明天下午三点提醒我开会", "")).toBe(false);
  });

  it("keeps partial-echo tolerance bounded", () => {
    // A five-character real command must survive even if two characters overlap.
    expect(looksLikeSelfEcho("提醒我开会", "明天下午三点提醒你开会，到时我会提前十分钟通知你。")).toBe(true);
    expect(looksLikeSelfEcho("查一下天气", "明天下午三点提醒你开会，到时我会提前十分钟通知你。")).toBe(false);
  });
});

/**
 * C1 barge-in acceptance regression on *real* StepFun ASR output (measured
 * 2026-11-20). The transcripts below are not hand-written echo theory: they are
 * what `stepaudio-2.5-asr` returned for
 *   (a) the 12 assistant TTS lines replayed into the microphone (self-echo),
 *   (b) 20 Windows-SAPI user barge-ins read through the same ASR,
 *   (c) 20 AISHELL-1 bystander sentences and 5 short feedback words.
 *
 * Measured result with this guard: 12/12 self-echo lines blocked (0 self
 * interruptions), and 0/45 genuine interrupts/bystander utterances suppressed
 * by the guard. Keep both directions locked: a wider guard would swallow real
 * barge-ins, a narrower one lets the assistant interrupt itself.
 */
const PLAYING = "明天下午三点提醒你开会，到时候我会提前十分钟通知你。";

const REAL_ECHO_TRANSCRIPTS: ReadonlyArray<readonly [spoken: string, heard: string]> = [
  ["好的，已经为你创建下午三点的会议提醒。", "好的，已经为你创建下午 3 点的会议提醒。"],
  ["我再确认一下，不过这个时间和你之前的安排有冲突。", "我再确认一下，不过这个时间和你之前的安排有冲突。"],
  ["另外还有两张卡片没有保存，需要我一起处理吗？", "另外还有两张卡片没有保存，需要我一起处理吗？"],
  ["已经取消这个限购提醒，其他内容保持不变。", "已经取消这个限购提醒，其他内容保持不变。"],
  ["你可以继续说，我会在后台把结果整理成卡片。", "你可以继续说，我会在后台把结果整理成卡片。"],
  ["正在查询明天上海的天气，请稍等。", "正在查询明天上海的天气，请稍等。"],
  ["提醒已经设置好了，需要我再说一遍吗？", "提醒已经设置好了，需要我再说一遍吗？"],
  ["这个任务需要三个步骤，目前完成第一步。", "这个任务需要三个步骤，目前完成第一步。"],
  ["如果你不确定，我可以先不做修改。", "如果你不确定，我可以先不做修改。"],
  ["抱歉，我没有听清，你能再说一次吗？", "抱歉，我没有听清，你能再说一次吗？"],
  ["今天一共创建了四张卡片。", "今天一共创建了 4 张卡片。"],
  ["好的，已经切换到设计讨论这个空间。", "好的，已经切换到设计讨论这个空间。"],
];

const REAL_BARGE_IN_TRANSCRIPTS = [
  "停一下", "等一下，不是这个。", "不对，我说的是后天。", "别说了。", "取消刚才那个。",
  "换个话题。", "停停停", "先等一下，我看一下。", "不是，我要的是明天。", "等一下，等一下。",
  "取消掉这个提醒。", "说点别的吧。", "重新来，这个不对。", "别念了。", "我说的是下午，不是上午。",
  "停，先别说。", "不说这个了。", "取消，取消。", "等一下，我改一下时间。", "另外再加一个条件。",
];

const REAL_NON_INTERRUPT_TRANSCRIPTS = [
  // AISHELL-1 bystander speech (news reading), ASR hypothesis.
  "而对面楼市成交抑制作用最大的限购",
  "也成为地方政府的眼中钉",
  "自6月底呼和浩特市率先宣布取消限购后",
  "各地政府便纷纷跟进",
  "仅一个多月的时间里",
  "除了北京、上海、广州、深圳四个一线城市和三亚之外",
  "46 个限购城市当中",
  "41 个已正式取消或变相放松了限购。",
  "财政金融政策紧随其后而来",
  "显示出了极强的威力",
  "放松了与自住需求密切相关的房贷政策",
  "其中包括对拥有一套住房并已结清相应购房贷款的家庭",
  "为改善居住条件，再次申请贷款购买普通商品住房。",
  "银行业金融机构执行首套房贷款政策",
  "这个后来被称为 930 新政策的措施",
  "被市场公认为是今年对楼市影响最大的一个政策。",
  "以提高住房公积金缴存职工住房消费能力",
  "支持缴存职工购买首套和改善型自住住房。",
  "通过财政补贴手段鼓励购房的地区也在不断增加。",
  "其中多项政策惠及购房者。",
  // Short feedback words / backchannel, ASR hypothesis.
  "文", "好的", "对", "闻啊闻", "好",
];

describe("real ASR transcripts (C1 acceptance regression)", () => {
  it.each(REAL_ECHO_TRANSCRIPTS)("blocks assistant self-echo, so 0/12 can interrupt: %s", (spoken, heard) => {
    expect(looksLikeSelfEcho(heard, spoken)).toBe(true);
  });

  it.each(REAL_BARGE_IN_TRANSCRIPTS)("does not suppress a genuine barge-in: %s", (heard) => {
    expect(looksLikeSelfEcho(heard, PLAYING)).toBe(false);
  });

  it.each(REAL_NON_INTERRUPT_TRANSCRIPTS)("does not silence bystander / feedback speech: %s", (heard) => {
    expect(looksLikeSelfEcho(heard, PLAYING)).toBe(false);
  });
});

