"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { removeDocumentAction } from "@/app/(desk)/actions";
import { ATTACHMENT_MAX_BYTES, ACCEPT, sizeLabel } from "@/lib/attachments";
import { DOC_KINDS, DOC_LABEL, type DocKind } from "@/lib/documents";
import { useToast } from "./kit/toast";

export type DocItem = { id: string; kind: DocKind; name: string; bytes: number; when: string; by: string };

/**
 * The documents on a load: what is kept (open or save each), and a place to add one (the rate confirmation, the proof of delivery, a receipt). Factoring's packet is made of
 * these, so a document that is not here is not sent. Once the invoice has gone to a factor the list is as it was sent and cannot change.
 */
export function LoadDocuments({ loadId, items, locked, defaultKind = "other" }: { loadId: string; items: DocItem[]; locked: string | null; defaultKind?: DocKind }) {
  const router = useRouter();
  const toast = useToast();
  const [kind, setKind] = React.useState<DocKind>(defaultKind);
  const [busy, setBusy] = React.useState(false);
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
        <p className="tl-note" style={{ marginBottom: 10 }}>No documents are kept on this load. Add the rate confirmation and the proof of delivery: factoring sends only what is here.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: "0 0 10px", padding: 0, display: "grid", gap: 6 }}>
          {items.map((d) => (
            <li key={d.id} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <span className="tl-chip muted">{DOC_LABEL[d.kind]}</span>
              <a href={`/documents/${d.id}`} target="_blank" rel="noopener noreferrer">
                {d.name}
              </a>
              <span className="tl-sub">
                {sizeLabel(d.bytes)} · {d.when} · {d.by}
              </span>
              {locked ? null : (
                <button type="button" className="tl-btn sm" disabled={busy} onClick={() => void remove(d)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {locked ? (
        <p className="tl-note">{locked}</p>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select value={kind} onChange={(e) => setKind(e.target.value as DocKind)} aria-label="What kind of document">
            {DOC_KINDS.map((k) => (
              <option key={k} value={k}>
                {DOC_LABEL[k]}
              </option>
            ))}
          </select>
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
