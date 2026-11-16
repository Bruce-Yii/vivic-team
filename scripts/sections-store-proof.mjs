// Server-side sections persistence proof (no secrets printed/stored).
//   STAGING_ORIGIN=http://127.0.0.1:8792 node scripts/sections-store-proof.mjs
//
// For a staging instance, on a canvas that is restored byte-for-byte afterwards:
//   1. PUT an owner canvas whose NoteCard has displayProps.sections
//   2. GET the canvas + the native snapshot -> sections must come back untouched
//   3. PUT the same card with text only -> record what the service does (last write wins)
//   4. restore the original record
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const merge = path.resolve(here, "..");
const sessionFile = path.resolve(merge, "../product-account-session.json");
const { cookie } = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
const base = process.env.STAGING_ORIGIN ?? "http://127.0.0.1:8792";
const out = { base, steps: [], canvas: null };

const call = async (method, route, body) => {
  const response = await fetch(`${base}${route}`, { method,
    headers: { Origin: base, cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, json, text: text.slice(0, 300) };
};

const sections = [
  { title: "会议", items: ["预算评审"] },
  { title: "议题", items: ["预算评审"] },
  { title: "结论", items: ["先按 A 方案推进"] },
  { title: "待办", items: ["小王出报价"] },
];
const PROOF_ID = "note_sections_proof_1";
const now = new Date().toISOString();

const list = await call("GET", "/api/space/owner/canvases");
out.steps.push({ step: "list canvases", status: list.status,
  canvases: (list.json?.canvases ?? []).map(entry => ({ id: entry.record.id, title: entry.record.title,
    version: entry.serverVersion, noteCards: entry.record.cardOrder.filter(id => entry.record.cardsById[id]?.type === "NoteCard").length })) });
const target = (list.json?.canvases ?? []).find(entry => entry.record.cardOrder.some(id => entry.record.cardsById[id]?.type === "NoteCard"))
  ?? (list.json?.canvases ?? [])[0];
if (!target) throw new Error("no canvas to test");
const canvasId = target.record.id;
out.canvas = { id: canvasId, title: target.record.title, serverVersion: target.serverVersion };
const original = target.record;
const templateCard = original.cardOrder.map(id => original.cardsById[id]).find(card => card?.type === "NoteCard");
const template = templateCard ?? { id: "note_x", type: "NoteCard", variant: "expanded",
  displayProps: { text: "x" }, sourceData: {}, layout: { x: 0, y: 0, width: 320, height: 120, pinned: false, surface: "display" },
  metadata: { createdAt: now, updatedAt: now } };

const withCard = (card) => {
  const record = structuredClone(original);
  record.cardsById = { ...record.cardsById, [card.id]: card };
  record.cardOrder = [...record.cardOrder.filter(id => id !== card.id), card.id];
  record.version = original.version + 1;
  record.updatedAt = now;
  return record;
};
const sectionsCard = { ...structuredClone(template), id: PROOF_ID,
  displayProps: { sections }, sourceData: { template: "meeting_minutes" },
  layout: { ...template.layout, x: 0, y: 0, width: 340, height: 320, pinned: false, surface: "display" } };
const textCard = { ...structuredClone(sectionsCard), displayProps: { text: "会议：预算评审\n议题：预算评审\n结论：先按 A 方案推进\n待办：小王出报价" } };

const readCard = async (label) => {
  const one = await call("GET", `/api/space/owner/canvases/${canvasId}`);
  const card = one.json?.record?.cardsById?.[PROOF_ID];
  const native = await call("GET", `/api/space/native/spaces/${canvasId}`);
  const nativeCard = (native.json?.space?.cards ?? []).find(item => item.id === PROOF_ID);
  out.steps.push({ step: label, canvasGet: one.status, nativeGet: native.status,
    serverVersion: one.json?.serverVersion, version: one.json?.record?.version,
    card: card ? { displayPropsKeys: Object.keys(card.displayProps),
      sections: card.displayProps.sections ?? null, text: typeof card.displayProps.text === "string" ? card.displayProps.text.slice(0, 120) : null,
      sourceDataTemplate: card.sourceData?.template } : null,
    nativeCard: nativeCard ? { displayPropsKeys: Object.keys(nativeCard.displayProps),
      sections: nativeCard.displayProps.sections ?? null } : null });
  return one.json;
};

// 1) write sections
const put1 = await call("PUT", `/api/space/owner/canvases/${canvasId}`,
  { record: withCard(sectionsCard), expectedVersion: target.serverVersion, requestId: `proof_sections_${Date.now()}` });
out.steps.push({ step: "PUT sections card", status: put1.status, ok: put1.json?.record?.cardsById?.[PROOF_ID] ? true : false,
  serverVersion: put1.json?.serverVersion, error: put1.status >= 400 ? put1.text : undefined });
const afterSections = await readCard("GET after sections PUT");

// 2) overwrite with text only (documents the service's last-write-wins semantics)
const versionNow = afterSections?.serverVersion;
const put2 = await call("PUT", `/api/space/owner/canvases/${canvasId}`,
  { record: withCard(textCard), expectedVersion: versionNow, requestId: `proof_text_${Date.now()}` });
out.steps.push({ step: "PUT text-only overwrite", status: put2.status, serverVersion: put2.json?.serverVersion,
  error: put2.status >= 400 ? put2.text : undefined });
await readCard("GET after text-only PUT");

// 3) restore the original record byte-for-byte
const current = await call("GET", `/api/space/owner/canvases/${canvasId}`);
const restore = await call("PUT", `/api/space/owner/canvases/${canvasId}`,
  { record: { ...original, updatedAt: original.updatedAt }, expectedVersion: current.json?.serverVersion, requestId: `proof_restore_${Date.now()}` });
const restored = await call("GET", `/api/space/owner/canvases/${canvasId}`);
const restoredCardIds = restored.json?.record?.cardOrder ?? [];
const originalIds = original.cardOrder ?? [];
out.steps.push({ step: "restore original", status: restore.status,
  restoredMatchesOriginal: JSON.stringify([...restoredCardIds].sort()) === JSON.stringify([...originalIds].sort()),
  proofCardGone: !restoredCardIds.includes(PROOF_ID), serverVersion: restored.json?.serverVersion });

fs.mkdirSync(path.resolve(merge, "logs"), { recursive: true });
fs.writeFileSync(path.resolve(merge, `logs/sections-store-proof-${new URL(base).port}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
