/**
 * Entity spellings the host can resolve without a model.
 *
 * Why this exists: the host used to resolve a target only by literal title /
 * alias containment, so "这张谷歌的卡片" could not find 「Google 公司介绍」 — the
 * model's own correct id was then replaced by whatever the host's fallback
 * picked (sc-15). A translation table is a deterministic derivation, not a
 * decision: it never chooses an action, it only widens which *name* a card has.
 *
 * Rules:
 *  - a group lists the accepted spellings of one entity; the first member is the
 *    primary (Chinese) name, the rest are its English/alias forms;
 *  - matching squashes case, whitespace and punctuation on both sides, and
 *    requires a key of at least two characters, so single-letter names such as
 *    "X" are never matched;
 *  - a card "owns" a group when any spelling appears inside its title or one of
 *    its aliases; the user's words may then use any *other* spelling of the same
 *    group;
 *  - groups stay proper nouns. Ambiguous everyday words ("理想", "大众") are
 *    deliberately absent: a false positive there is worse than a missed alias,
 *    because the model can still fill the id itself.
 */
const TERM_GROUPS: readonly (readonly string[])[] = [
  ["谷歌", "google", "alphabet"],
  ["苹果", "apple"],
  ["微软", "microsoft"],
  ["亚马逊", "amazon"],
  ["脸书", "facebook", "meta"],
  ["推特", "twitter"],
  ["特斯拉", "tesla"],
  ["英伟达", "nvidia"],
  ["英特尔", "intel"],
  ["超威", "amd"],
  ["高通", "qualcomm"],
  ["台积电", "tsmc"],
  ["三星", "samsung"],
  ["华为", "huawei"],
  ["小米", "xiaomi"],
  ["腾讯", "tencent"],
  ["阿里巴巴", "alibaba"],
  ["淘宝", "taobao"],
  ["支付宝", "alipay"],
  ["字节跳动", "bytedance"],
  ["抖音", "tiktok"],
  ["京东", "jd"],
  ["拼多多", "pinduoduo"],
  ["百度", "baidu"],
  ["网易", "netease"],
  ["宁德时代", "catl"],
  ["比亚迪", "byd"],
  ["蔚来", "nio"],
  ["波音", "boeing"],
  ["空客", "airbus"],
  ["迪士尼", "disney"],
  ["奈飞", "netflix"],
  ["星巴克", "starbucks"],
  ["麦当劳", "mcdonalds"],
  ["沃尔玛", "walmart"],
  ["雀巢", "nestle"],
  ["中国移动", "china mobile"],
  ["中国联通", "china unicom"],
  ["中国电信", "china telecom"],
];

/** Case/space/punctuation-insensitive form used for every name comparison. */
export const squash = (value: string): string => value.normalize("NFKC").toLowerCase()
  .replace(/[\s\u3000]+/gu, "")
  .replace(/[·•.,，。!！?？:：;；'"“”‘’()（）[\]【】《》〈〉「」『』〔〕<>_\-—/\\|]/gu, "");

/** Every spelling of every entity this name mentions, plus nothing else. */
export function equivalentTerms(name: string): string[] {
  const flat = squash(name);
  const out: string[] = [];
  for (const group of TERM_GROUPS) {
    if (group.some(term => flat.includes(squash(term)))) out.push(...group);
  }
  return out;
}

/**
 * The keys a card answers to: its squashed title/aliases plus the equivalent
 * spellings of any entity they mention. A key shorter than two characters is
 * dropped (it would match almost any sentence).
 */
export function matchKeysOf(names: Array<string | undefined>): string[] {
  const keys = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string" || !name.trim()) continue;
    keys.add(squash(name));
    for (const term of equivalentTerms(name)) keys.add(squash(term));
  }
  return [...keys].filter(key => key.length >= 2);
}

/** Does the user's own sentence name this card (by title, alias or translation)? */
export function namesCard(text: string, names: Array<string | undefined>): boolean {
  const flat = squash(text);
  return matchKeysOf(names).some(key => flat.includes(key));
}
