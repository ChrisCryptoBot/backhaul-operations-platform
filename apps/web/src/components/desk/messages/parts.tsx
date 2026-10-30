import React from "react";
import { labelOf, linkParts, sizeLabel } from "@/lib/attachments";
import type { AttachmentView } from "@/server/tl/messages";

/**
 * A message's words, with any web address made a link. Only http and https addresses become links; they show the real host beside them, open in a new tab with
 * no opener, and are never fetched or previewed by the desk. Everything else stays plain text (React escapes it).
 */
export function MessageText({ body }: { body: string }) {
  if (!body) return null;
  return (
    <p>
      {linkParts(body).map((p, i) =>
        p.kind === "text" ? (
          <React.Fragment key={i}>{p.text}</React.Fragment>
        ) : (
          <span key={i} className="ms-link">
            <a href={p.url} target="_blank" rel="noopener noreferrer nofollow" title={p.url}>
              {p.text}
            </a>
            <small> {p.host}</small>
          </span>
        )
      )}
    </p>
  );
}

/** The pictures and files on a message: a picture shows in the bubble and opens full size; a file is a row with its type and size, saved (never opened) from here. */
export function Attachments({ items }: { items: AttachmentView[] }) {
  if (items.length === 0) return null;
  const images = items.filter((a) => a.kind === "image");
  const files = items.filter((a) => a.kind !== "image");
  return (
    <div className="ms-atts">
      {images.length > 0 ? (
        <div className={`ms-imgs n${Math.min(images.length, 4)}`}>
          {images.map((a) => (
            <a key={a.id} href={`/messages/file/${a.id}`} target="_blank" rel="noopener noreferrer" aria-label={`Open photo${a.name ? ` ${a.name}` : ""}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/messages/file/${a.id}`} alt={a.name ? `Photo: ${a.name}` : "Photo"} loading="lazy" />
            </a>
          ))}
        </div>
      ) : null}
      {files.map((a) => (
        <a key={a.id} className="ms-file" href={`/messages/file/${a.id}`} download={a.name ?? "file"}>
          <span className="ms-file-ico" aria-hidden="true">
            {labelOf(a.mime)}
          </span>
          <span className="ms-file-name">
            {a.name ?? "File"}
            <small>
              {labelOf(a.mime)} · {sizeLabel(a.bytes)}
            </small>
          </span>
          <span className="ms-file-get">Download</span>
        </a>
      ))}
    </div>
  );
}
