"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { markThreadReadAction } from "@/app/(desk)/actions";
import { ACCEPT, ATTACHMENTS_PER_MESSAGE, ATTACHMENT_MAX_BYTES, REFUSAL, safeName, sizeLabel, typeOf } from "@/lib/attachments";
import { CANNED, MAX_BODY, cleanBody } from "@/lib/messages";

type LoadChoice = { id: string; loadNumber: string | null; customer: string | null };
type Picked = { key: string; file: File; preview: string | null };

/** Opening a conversation reads it: the driver's messages in it stop counting on the sidebar. Does nothing when there is nothing unread. */
export function MarkRead({ driverId, unread }: { driverId: string; unread: number }) {
  const router = useRouter();
  React.useEffect(() => {
    if (unread <= 0) return;
    let live = true;
    void markThreadReadAction(driverId).then((n) => {
      if (live && n > 0) router.refresh();
    });
    return () => {
      live = false;
    };
  }, [driverId, unread, router]);
  return null;
}

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

/**
 * The box under a conversation. Enter sends, Shift+Enter starts a new line. Pictures and files can be attached with the button, dropped on the box, or pasted.
 * A send carries its own id, so a double press or a retry saves one message. The browser checks size, count and type for a quick answer; the server checks again,
 * by the file's real contents, and its answer is the one that counts. The note under the conversation says plainly that nothing carries a message to a phone yet.
 */
export function Composer({ driverId, driverName, loads }: { driverId: string; driverName: string; loads: LoadChoice[] }) {
  const router = useRouter();
  const box = React.useRef<HTMLTextAreaElement>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const [text, setText] = React.useState("");
  const [loadId, setLoadId] = React.useState("");
  const [picked, setPicked] = React.useState<Picked[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [over, setOver] = React.useState(false);
  const clientId = React.useRef(newId());
  const previews = React.useRef<string[]>([]);

  const dropAll = React.useCallback(() => {
    for (const u of previews.current) URL.revokeObjectURL(u);
    previews.current = [];
    setPicked([]);
  }, []);

  React.useEffect(() => {
    setText("");
    setLoadId("");
    setError(null);
    dropAll();
    clientId.current = newId();
  }, [driverId, dropAll]);

  React.useEffect(() => () => previews.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const put = (line: string) => {
    setText((t) => (t.trim() ? `${t.trimEnd()} ${line}` : line));
    box.current?.focus();
  };

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list);
    if (incoming.length === 0) return;
    const next = [...picked];
    const refused: string[] = [];
    for (const file of incoming) {
      if (next.length >= ATTACHMENTS_PER_MESSAGE) {
        refused.push(`A message can carry up to ${ATTACHMENTS_PER_MESSAGE} files.`);
        break;
      }
      const t = typeOf(file.name, file.type);
      if (!t) refused.push(`${safeName(file.name)}: ${REFUSAL.type}`);
      else if (file.size === 0) refused.push(`${safeName(file.name)}: ${REFUSAL.empty}`);
      else if (file.size > ATTACHMENT_MAX_BYTES) refused.push(`${safeName(file.name)}: ${REFUSAL.too_big}`);
      else {
        const preview = t.kind === "image" ? URL.createObjectURL(file) : null;
        if (preview) previews.current.push(preview);
        next.push({ key: newId(), file, preview });
      }
    }
    setPicked(next);
    setError(refused.length > 0 ? refused.join(" ") : null);
  }

  function remove(key: string) {
    setPicked((p) => {
      const gone = p.find((x) => x.key === key);
      if (gone?.preview) {
        URL.revokeObjectURL(gone.preview);
        previews.current = previews.current.filter((u) => u !== gone.preview);
      }
      return p.filter((x) => x.key !== key);
    });
  }

  async function send() {
    if (pending) return;
    const clean = cleanBody(text, { allowEmpty: picked.length > 0 });
    if (!clean.ok) {
      setError(clean.error);
      box.current?.focus();
      return;
    }
    setPending(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("driverId", driverId);
      form.set("body", clean.body);
      form.set("clientId", clientId.current);
      if (loadId) form.set("loadId", loadId);
      for (const p of picked) form.append("files", p.file, p.file.name);
      const res = await fetch("/messages/send", { method: "POST", body: form });
      const out = (await res.json().catch(() => null)) as { ok: boolean; error?: string } | null;
      if (!res.ok || !out?.ok) {
        setError(out?.error ?? "Could not save that. Check the connection and try again.");
        return;
      }
      setText("");
      setLoadId("");
      dropAll();
      clientId.current = newId();
      router.refresh();
      box.current?.focus();
    } catch {
      setError("Could not save that. Check the connection and try again.");
    } finally {
      setPending(false);
    }
  }

  const left = MAX_BODY - text.length;
  const canSend = !pending && (text.trim().length > 0 || picked.length > 0);
  return (
    <form
      className={`ms-composer${over ? " drop" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (e.dataTransfer.files.length > 0) {
          e.preventDefault();
          setOver(false);
          addFiles(e.dataTransfer.files);
        }
      }}>
      <div className="ms-canned" aria-label="Ready-written lines">
        {CANNED.map((c) => (
          <button type="button" key={c} className="ms-chip" onClick={() => put(c)}>
            {c}
          </button>
        ))}
      </div>
      {picked.length > 0 ? (
        <ul className="ms-picked" aria-label="Attached">
          {picked.map((p) => (
            <li key={p.key} className="ms-pick">
              {p.preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.preview} alt="" width={36} height={36} />
              ) : (
                <span className="ms-pick-ico" aria-hidden="true">
                  {typeOf(p.file.name, p.file.type)?.label ?? "File"}
                </span>
              )}
              <span className="ms-pick-name">
                {safeName(p.file.name)}
                <small>{sizeLabel(p.file.size)}</small>
              </span>
              <button type="button" className="ms-pick-x" onClick={() => remove(p.key)} aria-label={`Remove ${safeName(p.file.name)}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={box}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files);
          if (files.length > 0) {
            e.preventDefault();
            addFiles(files);
          }
        }}
        rows={3}
        aria-label={`Message to ${driverName}`}
        placeholder={`Message ${driverName}. Drop or paste pictures and files here.`}
        aria-invalid={error ? true : undefined}
      />
      <div className="ms-composer-foot">
        <input ref={input} type="file" accept={ACCEPT} multiple hidden onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          e.target.value = "";
        }} />
        <button type="button" className="tl-btn sm" onClick={() => input.current?.click()} disabled={picked.length >= ATTACHMENTS_PER_MESSAGE} aria-label="Attach pictures or files">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7L14 4.5a3.3 3.3 0 0 1 4.7 4.7L10.2 17.7a1.7 1.7 0 0 1-2.4-2.4L15 8" />
          </svg>
          Attach
        </button>
        {loads.length > 0 ? (
          <label className="ms-about">
            <span>About</span>
            <select value={loadId} onChange={(e) => setLoadId(e.target.value)}>
              <option value="">No load</option>
              {loads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.loadNumber ?? "Load"}
                  {l.customer ? ` · ${l.customer}` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span className={`ms-count${left < 0 ? " over" : ""}`} aria-live="polite">
          {left <= 200 ? `${left} left` : ""}
        </span>
        <button type="submit" className="tl-btn primary" disabled={!canSend}>
          {pending ? "Saving…" : "Save message"}
        </button>
      </div>
      <p className="ms-limits">Pictures, PDF, Word, Excel, CSV and text files, up to {ATTACHMENTS_PER_MESSAGE} a message and {ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB each. Links are fine.</p>
      {error ? (
        <p className="tl-note warn" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
