import { randomUUID } from "node:crypto";
import { ActionEnvelopeSchema, type Action } from "@vivic/contracts";

/**
 * Shared envelope assembly for every deterministic (0-model) path. Keeping one
 * implementation means a fast path and the planner return the same wire shape,
 * including the request id format the control page expects.
 */
export const assembleEnvelope = (actions: Action[], canvasId: string, spokenText?: string) => {
  const parsed = ActionEnvelopeSchema.safeParse({ schemaVersion: "0.6",
    requestId: `llm_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    canvasId, spokenText, actions });
  return parsed.success ? parsed.data : null;
};

/**
 * One response may now carry a verified lookup *and* card tools. The lookup
 * envelope is committed first (its provider cards and sources), then the cards
 * the model built in the same batch. Camera actions are normalized once so the
 * merged batch never fights over the viewport; `null` means the combined batch
 * no longer fits the envelope contract, and the caller reports the partial
 * result honestly instead of silently dropping cards.
 */
export const mergeEnvelopes = (
  lookup: NonNullable<ReturnType<typeof assembleEnvelope>>,
  cards: NonNullable<ReturnType<typeof assembleEnvelope>> | undefined,
) => {
  if (!cards) return lookup;
  const actions = [...lookup.actions, ...cards.actions];
  const firstAwaken = actions.findIndex(action => action.type === "stage.awaken");
  const deduped = actions.filter((action, index) => action.type !== "stage.awaken" || index === firstAwaken);
  const creates = deduped.filter(action => action.type === "card.create");
  // More than one new card: no per-card focus, one camera move for the batch.
  const normalized = creates.length > 1
    ? [...deduped.filter(action => !["card.focus", "canvas.fit", "canvas.restore"].includes(action.type)), { type: "canvas.fit" as const }]
    : deduped;
  const spoken = [lookup.spokenText, cards.spokenText].filter((value): value is string => Boolean(value)).join("，");
  const parsed = ActionEnvelopeSchema.safeParse({ schemaVersion: "0.6", requestId: cards.requestId,
    canvasId: cards.canvasId, ...(spoken ? { spokenText: spoken.slice(0, 180) } : {}), actions: normalized });
  return parsed.success ? parsed.data : null;
};
