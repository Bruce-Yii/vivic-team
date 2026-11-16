import { CardRecordSchema, NewsCardSchema, SCENE_CARD_SIZES, type CardRecord, type SceneId } from "@vivic/contracts";
import { z } from "zod";
import { createCardActions } from "./build.js";
import { defineCardContract, type BuiltinCardContract } from "./types.js";

const display = NewsCardSchema.shape.displayProps.shape;
const slots = z.strictObject({
  headline: display.headline,
  summary: display.summary,
  keyPoints: display.keyPoints,
});

/**
 * The only image reference a card may carry from an image request: a blob the
 * host persisted for *this* request (account + space + device scoped, generated
 * by `hosted/assets.ts`). It is matched by shape here and never copied out of a
 * tool argument, so a model cannot name an image, and a request without a
 * persisted attachment can never reach the image paths below.
 */
export const TRUSTED_IMAGE_REF = /^media:image_[a-f0-9]{64}$/u;
export const isTrustedImageRef = (value: unknown): value is string =>
  typeof value === "string" && TRUSTED_IMAGE_REF.test(value);

/**
 * Scenes that keep their own builder and only receive the host's photo: the
 * reference is merged into the card the scene produced. `news_summary` is not
 * here — a summary of an attached image has no article text to ground itself
 * against, so `imageAnalysisContract` (below) builds that NewsCard instead.
 */
export const IMAGE_SCENE_IDS: ReadonlySet<SceneId> = new Set<SceneId>([
  "photo_story", "photo_gallery", "photo_memory",
]);

/**
 * Put the request's own image on a card that its contract has already built.
 * Only the media field is host-owned: id, layout, metadata, sources and every
 * text field stay exactly what the builder produced, and the merged record is
 * re-validated by the shared `CardRecord` contract before it can be committed.
 * (NewsCard never needs this: `imageAnalysisContract` builds it with the image
 * in one step.) A card type with no image field is returned unchanged — nothing
 * is invented.
 */
export function attachTrustedImage(card: CardRecord, ref: string): CardRecord {
  if (!isTrustedImageRef(ref)) throw new Error("图片引用必须是本次请求已留存的可信图片。");
  const props = card.displayProps as Record<string, unknown>;
  const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
  const title = text(props.title);
  let displayProps: Record<string, unknown>;
  switch (card.type) {
    case "StoryCarouselCard": {
      // One uploaded photo backs every narrated slide; a slide the host cannot
      // read is left as built rather than dropped or rewritten.
      const slides = Array.isArray(props.slides) ? props.slides : [];
      displayProps = { ...props, slides: slides.map(slide => slide && typeof slide === "object"
        ? { ...(slide as Record<string, unknown>), image: ref } : slide) };
      break;
    }
    case "GalleryCard": {
      const images = Array.isArray(props.images) ? props.images : [];
      displayProps = { ...props, images: [{ src: ref, ...(title ? { alt: title } : {}) }, ...images] };
      break;
    }
    case "PhotoCoverCard":
      displayProps = { ...props, image: { src: ref, ...(title ? { alt: title } : {}) } };
      break;
    default:
      return card;
  }
  return CardRecordSchema.parse({ ...card, displayProps });
}

export const imageAnalysisContract: BuiltinCardContract = defineCardContract({
  id: "image_analysis",
  name: "图片分析",
  description: "仅分析用户本次明确发送的图片，填写一句结论、摘要和最多五条要点；看不清时澄清，不猜测。图片引用由宿主提供。",
  examples: ["分析这张图片", "总结这张图里的内容"],
  cardType: "NewsCard",
  slots,
  build(value, ctx, now) {
    if (!isTrustedImageRef(ctx.trustedImageRef)) {
      throw new Error("图片分析需要本次请求已留存的可信图片。");
    }
    return createCardActions({
      type: "NewsCard", sourceData: {},
      displayProps: { ...value, image: ctx.trustedImageRef, summaryBy: "ai" },
    }, SCENE_CARD_SIZES.news_summary, ctx, now, "standard");
  },
});
