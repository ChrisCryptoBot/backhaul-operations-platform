/** The kinds of document kept on a load, and what each is called. Pure, so a screen and the server say the same words (src/server/tl/documents.ts keeps them). */
export const DOC_KINDS = ["rate_con", "pod", "receipt", "other"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const DOC_LABEL: Record<DocKind, string> = { rate_con: "Rate confirmation", pod: "Proof of delivery", receipt: "Receipt", other: "Other" };
export const isDocKind = (v: unknown): v is DocKind => typeof v === "string" && (DOC_KINDS as readonly string[]).includes(v);
