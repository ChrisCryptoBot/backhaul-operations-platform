/** The kinds of document kept on a load, and what each is called. Pure, so a screen and the server say the same words (src/server/tl/documents.ts keeps them). */
export const DOC_KINDS = ["rate_con", "pod", "bol", "instructions", "lumper", "receipt", "osd_photo", "other"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const DOC_LABEL: Record<DocKind, string> = {
  rate_con: "Rate confirmation",
  pod: "Proof of delivery",
  bol: "Bill of lading",
  instructions: "Delivery instructions",
  lumper: "Lumper receipt",
  receipt: "Receipt",
  osd_photo: "OS&D photo",
  other: "Other"
};
export const isDocKind = (v: unknown): v is DocKind => typeof v === "string" && (DOC_KINDS as readonly string[]).includes(v);

/**
 * What a driver's phone is sent (sync plan Step 4, Chris 2026-11-22). These always go to the load's driver; "other" only when the dispatcher ticks it; a rate confirmation, a money
 * receipt and a proof of delivery never do. The phone project's table holds the same list (20261122000400_bridge_load_documents.sql).
 */
export const AUTO_TO_DRIVER = ["bol", "instructions", "lumper"] as const;
export const CHOSEN_TO_DRIVER = "other" as const;
export const goesToDriver = (d: { kind: string; toDriver: boolean }): boolean => (AUTO_TO_DRIVER as readonly string[]).includes(d.kind) || (d.kind === CHOSEN_TO_DRIVER && d.toDriver);
