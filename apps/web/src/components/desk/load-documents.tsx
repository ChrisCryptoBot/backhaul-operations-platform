"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { removeDocumentAction } from "@/app/(desk)/actions";
import { ATTACHMENT_MAX_BYTES, ACCEPT, sizeLabel } from "@/lib/attachments";
import { DOC_KINDS, DOC_LABEL, type DocKind } from "@/lib/documents";
import { useToast } from "./kit/toast";

export type DocItem = { id: string; kind: DocKind; name: string; bytes: number; when: string; by: string; /** The delivery stop a proof of delivery belongs to, in words ("Stop 3, Columbus Receiving"). */ stop?: string | null };
export type DeliveryStopOption = { id: string; label: string };

/**
 * The documents on a load: what is kept (open or save each), and a place to add one (the rate confirmation, the proof of delivery, a receipt). Factoring's packet is made of
 * these, so a document that is not here is not sent. Once the invoice has gone to a factor the list is as it was sent and cannot change.
 */
export function LoadDocuments({
  loadId,
  items,
  locked,
  defaultKind = "other",
  deliveryStops = [],
  selectedId,
  onSelectDoc,
  onDocClick
}: {
  loadId: string;
  items: DocItem[];
  locked: string | null;
  defaultKind?: DocKind;
  /** The delivery stops, so a proof of delivery can be tied to one when there is more than one. */
  deliveryStops?: DeliveryStopOption[];
  selectedId?: string | null;
  onSelectDoc?: (doc: DocItem) => void;
  onDocClick?: (doc: DocItem) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [kind, setKind] = React.useState<DocKind>(defaultKind);
  const [busy, setBusy] = React.useState(false);
  const [stopId, setStopId] = React.useState("");
  // A removal asks first: the file is gone with it.
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const input = React.useRef<HTMLInputElement>(null);

  async function upload() {
    const file = input.current?.files?.[0];
    if (!file) {
      toast({ text: "Choose a file first.", tone: "bad" });
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.set("loadId", loadId);
      form.set("kind", kind);
      if (kind === "pod" && stopId) form.set("stopId", stopId);
      form.set("file", file);
      const res = await fetch("/documents/upload", { method: "POST", body: form });
      const out = (await res.json().catch(() => null)) as { ok: boolean; error?: string } | null;
      if (out?.ok) {
        toast({ text: `${file.name} kept.`, tone: "ok" });
        if (input.current) input.current.value = "";
        router.refresh();
      } else toast({ text: out?.error ?? "That could not be kept. Try again.", tone: "bad" });
    } catch {
      toast({ text: "That could not be kept. Check the connection and try again.", tone: "bad" });
    } finally {
      setBusy(false);
    }
  }

  async function remove(d: DocItem) {
    setBusy(true);
    const out = await removeDocumentAction(d.id);
    setBusy(false);
    if (out.ok) {
      toast({ text: `${d.name} removed.`, tone: "ok" });
      router.refresh();
    } else toast({ text: out.error, tone: "bad" });
  }

  return (
    <div>
      {items.length === 0 ? (
        <p className="tl-note" style={{ marginBottom: 10 }}>
          No documents are kept on this load. Add the rate confirmation and the proof of delivery: factoring sends only what is here.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: "0 0 12px", padding: 0, display: "grid", gap: 6 }}>
          {items.map((d) => {
            const isSelected = d.id === selectedId;
            return (
              <li
                key={d.id}
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 12px",
                  borderRadius: "var(--db-r-md)",
                  border: isSelected ? "1px solid var(--db-accent)" : "1px solid var(--db-border)",
                  background: isSelected ? "color-mix(in srgb, var(--db-accent) 10%, var(--db-bg-card))" : "var(--db-bg-elev-1)",
                  transition: "all 120ms ease"
                }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0, flexWrap: "wrap" }}>
                  <span className="tl-chip muted sm" style={{ textTransform: "uppercase", fontWeight: 700, fontSize: 10 }}>
                    {DOC_LABEL[d.kind]}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      onSelectDoc?.(d);
                      onDocClick?.(d);
                    }}
                    title="Click to view and expand"
                    style={{
                      border: 0,
                      background: "transparent",
                      padding: 0,
                      margin: 0,
                      font: "inherit",
                      fontWeight: 600,
                      fontSize: 13,
                      color: "var(--db-fg)",
                      cursor: "pointer",
                      textAlign: "left",
                      textDecoration: "underline",
                      textUnderlineOffset: 2,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      maxWidth: "min(360px, 45vw)"
                    }}>
                    {d.name}
                  </button>
                  <span className="tl-sub" style={{ fontSize: 11 }}>
                    {sizeLabel(d.bytes)} · {d.when} · {d.by}
                  </span>
                  {d.stop ? <span className="tl-sub" style={{ fontSize: 11 }}>· {d.stop}</span> : null}
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                  <button
                    type="button"
                    className="tl-btn ghost sm"
                    style={{ fontSize: 11, padding: "3px 8px" }}
                    onClick={() => onSelectDoc?.(d)}
                    title="View in preview">
                    Preview
                  </button>
                  {locked ? null : confirming === d.id ? (
                    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                      <span className="tl-sub" style={{ fontSize: 11, color: "var(--db-neg)" }}>Remove?</span>
                      <button type="button" className="tl-btn sm" disabled={busy} onClick={() => void remove(d).then(() => setConfirming(null))}>
                        Yes, remove
                      </button>
                      <button type="button" className="tl-btn ghost sm" onClick={() => setConfirming(null)}>
                        Keep it
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="tl-btn ghost sm" style={{ fontSize: 11, padding: "3px 8px", color: "var(--db-fg-dim)" }} disabled={busy} onClick={() => setConfirming(d.id)}>
                      Remove
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {locked ? (
        <p className="tl-note">{locked}</p>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", paddingTop: items.length > 0 ? 8 : 0, borderTop: items.length > 0 ? "1px solid var(--db-border-soft)" : "none" }}>
          <select value={kind} onChange={(e) => setKind(e.target.value as DocKind)} aria-label="What kind of document">
            {DOC_KINDS.map((k) => (
              <option key={k} value={k}>
                {DOC_LABEL[k]}
              </option>
            ))}
          </select>
          {kind === "pod" && deliveryStops.length > 1 ? (
            <select value={stopId} onChange={(e) => setStopId(e.target.value)} aria-label="Which delivery stop it is for">
              <option value="">All deliveries</option>
              {deliveryStops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          ) : null}
          <input ref={input} type="file" accept={ACCEPT} aria-label="The file to keep" />
          <button type="button" className="tl-btn" disabled={busy} onClick={() => void upload()}>
            {busy ? "Keeping…" : "Keep it"}
          </button>
          <span className="tl-sub">Up to {ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB; a PDF, a photo or a scan.</span>
        </div>
      )}
    </div>
  );
}
