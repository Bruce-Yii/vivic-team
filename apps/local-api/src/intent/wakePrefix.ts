/** A leading wake phrase ("嗨 Vivic，…") is addressing, not part of the command.
 * Left in place it is split into its own clause, which can never form card
 * parameters, so the whole sentence used to fail. Only a prefix followed by an
 * actual command is removed; a bare greeting is left for the greeting path. */
const NAME = String.raw`(?:vivic|vivi[kc]|维维克|薇薇克|微微克|维维可|唯唯克)`;
const SEP = String.raw`[\s,，、。.!！?？:：~～-]*`;
const GREETING = String.raw`(?:hi|hey|hello|嗨|嘿|哈喽|哈啰|你好)`;
const WITH_NAME = new RegExp(String.raw`^${SEP}(?:${GREETING}${SEP})?(?:${NAME}${SEP})*${NAME}(?=$|[\s,，、。.!！?？:：~～-]|(?!的)[㐀-鿿])${SEP}`, "iu");
// ASR may spell the name as "Vivek"; only accept it after an explicit greeting.
const VIVEK = new RegExp(String.raw`^${SEP}${GREETING}${SEP}vivek(?=$|[\s,，、。.!！?？:：~～-]|[㐀-鿿])${SEP}`, "iu");

export function stripWakePrefix(text: string): string {
  // Match the original text: NFKC would rewrite the user's full-width punctuation.
  const match = text.match(WITH_NAME) ?? text.match(VIVEK);
  if (!match) return text;
  const command = text.slice(match[0].length).trim();
  return command ? command : text;
}

/** ASR often turns the trailing "嗨" of a wake phrase into "打/大/海" and keeps
 * it as "打，添加待办…". A lone filler syllable before a comma and a command verb
 * is noise, not content ("明天，提醒我" keeps "明天": it is not in the list). */
const FILLER = new RegExp(String.raw`^[\s,，。.]*(?:打|大|嗨|嘿|海|害|哈|嗯|呃|啊|哎|诶|欸|喂|噢|哦|hi|hey|ok|okay)[\s,，、。.!！~～]+(?=(?:请|帮我|麻烦|给我)?(?:添加|新建|创建|建一|记一|记下|加个|聚焦|高亮|删除|删掉|把|给|显示|整理|进入|退出|倒计时|计时|提醒|设置|设个|打开|切换|换个|换成|撤销|做一|生成|介绍|标记))`, "iu");

export function stripFiller(text: string): string {
  const match = text.match(FILLER);
  return match ? text.slice(match[0].length) : text;
}
