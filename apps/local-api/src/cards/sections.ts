import type { Action } from "@vivic/contracts";

/**
 * Frontend without the NoteCard.sections contract: a structured note must never
 * reach the canvas as-is, or the old renderer shows an empty card. Flatten the
 * sections into the plain-text shape the deployed client already renders.
 *
 * Used by the template builder (before CardRecordSchema validation) and by the
 * intent pipeline for every envelope when `VIVIC_SECTIONS` is off.
 */

const SECTION_LINE = (section: { title?: unknown; items?: unknown }): string => {
  const title = typeof section.title === "string" ? section.title : "";
  const items = Array.isArray(section.items)
    ? section.items.filter((item): item is string => typeof item === "string")
    : [];
  return [title, ...items.map(item => `· ${item}`)].filter(Boolean).join("\n");
};

/** One structured-note `displayProps` → the text shape: sections are removed. */
export function flattenSectionsProps(props: Record<string, unknown>): { props: Record<string, unknown>; flattened: boolean } {
  const sections = props.sections;
  if (!Array.isArray(sections) || !sections.length) return { props, flattened: false };
  const text = sections.map(section => SECTION_LINE((section ?? {}) as { title?: unknown; items?: unknown }))
    .filter(Boolean).join("\n\n");
  const { sections: _sections, ...rest } = props;
  return { props: { ...rest, text }, flattened: true };
}

/** Every `NoteCard` created by this batch keeps text/bullets only. */
export function flattenNoteSections(actions: Action[]): Action[] {
  let changed = false;
  const next = actions.map(action => {
    if (action.type !== "card.create" || action.card.type !== "NoteCard") return action;
    const current = action.card.displayProps as Record<string, unknown>;
    const { props, flattened } = flattenSectionsProps(current);
    if (!flattened) return action;
    changed = true;
    return { ...action, card: { ...action.card, displayProps: props } };
  });
  return changed ? next : actions;
}

/** Same rule for a whole result envelope; a non-envelope result passes through. */
export function flattenEnvelopeSections<T extends { envelope?: { actions: Action[] } }>(result: T): T {
  if (!result.envelope) return result;
  const actions = flattenNoteSections(result.envelope.actions);
  return actions === result.envelope.actions ? result : { ...result, envelope: { ...result.envelope, actions } };
}
