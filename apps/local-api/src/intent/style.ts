/**
 * Reply-style presets for every model-facing system prompt.
 *
 * The deployed product speaks with a soft, warm tone ("温柔一点、柔和一点") by
 * default. The industry-standard way to do this (system-role persona/style
 * instructions carry across turns and outrank user instructions) is a short,
 * concrete style block appended to the system prompt — no fine-tuning, no
 * per-turn rewriting. Presets stay few and small.
 *
 * Two styles only:
 * - `warm` (default): the soft, patient brand voice.
 * - `normal`: no style block at all, i.e. the raw prompt.
 *
 * Configure with `VIVIC_REPLY_STYLE=warm|normal` (default `warm`). Every other
 * value — including the retired `concise` / `professional` / `off` names —
 * falls back to `warm`, so a stale deployment variable can never silently
 * strip the brand voice.
 */
export type ReplyStyle = "warm" | "normal";

const STYLE_PROMPTS: Record<Exclude<ReplyStyle, "normal">, string> = {
  warm: [
    "【语气】温柔、自然、有耐心，像在身边帮忙的朋友。",
    "用短句，先接住对方的意思再给结果；不用夸张的语气词和感叹号，不说教，不堆礼貌套话。",
    "追问时只问一个最关键的问题，用柔和的商量的口吻（例如“想先确认一下……”），不要像审问。",
    "出错或做不到时先简短说明，再给一个可执行的小建议，不找借口。",
  ].join(""),
};

export function resolveReplyStyle(value: string | undefined = process.env.VIVIC_REPLY_STYLE): ReplyStyle {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "normal" ? "normal" : "warm";
}

/** Text to append to a model system prompt; empty string for the plain `normal` style. */
export function replyStyleInstruction(style: ReplyStyle = resolveReplyStyle()): string {
  if (style === "normal") return "";
  return STYLE_PROMPTS.warm;
}
