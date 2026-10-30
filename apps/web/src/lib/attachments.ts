/**
 * What can go in a message besides words, and the checks a file passes before the desk keeps it. Pure: no disk, no database.
 *
 * The limits and the type list mirror the phone app's direct messages (4 a message, 10 MB each; PDF, Word, Excel, CSV and text files, and pictures) so a driver's phone and
 * the desk agree on what may be sent. A file is judged by its real first bytes, never by the name or the type it claims; a PDF with embedded script and an Office file
 * with macros are refused; a photo has its location and camera data removed (JPEG and PNG) before it is kept. Nothing is ever opened inside the desk: a file is saved by
 * whoever receives it.
 */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENTS_PER_MESSAGE = 4;
export const FILE_NAME_MAX = 120;

export type AttachmentKind = "image" | "file";
export type AttachmentType = { mime: string; exts: readonly string[]; label: string; kind: AttachmentKind };

export const ATTACHMENT_TYPES: readonly AttachmentType[] = [
  { mime: "application/pdf", exts: ["pdf"], label: "PDF", kind: "file" },
  { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", exts: ["docx"], label: "Word", kind: "file" },
  { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", exts: ["xlsx"], label: "Excel", kind: "file" },
  { mime: "text/csv", exts: ["csv"], label: "CSV", kind: "file" },
  { mime: "text/plain", exts: ["txt"], label: "Text", kind: "file" },
  { mime: "image/jpeg", exts: ["jpg", "jpeg"], label: "Photo", kind: "image" },
  { mime: "image/png", exts: ["png"], label: "Photo", kind: "image" },
  { mime: "image/webp", exts: ["webp"], label: "Photo", kind: "image" }
];

/** What the file picker is asked to show. */
export const ACCEPT = ATTACHMENT_TYPES.flatMap((t) => t.exts.map((e) => `.${e}`)).join(",");

const extOf = (name: string | null | undefined) => {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec((name ?? "").trim());
  return m ? m[1]!.toLowerCase() : "";
};

/** Which allowed type a file is. The extension decides; a name with no extension falls back to the type the sender's device reported (when it is one of ours). */
export function typeOf(name: string | null | undefined, mime?: string | null): AttachmentType | null {
  const e = extOf(name);
  if (e) return ATTACHMENT_TYPES.find((t) => t.exts.includes(e)) ?? null; // a name with an extension that is not ours is not ours, whatever the device says
  return ATTACHMENT_TYPES.find((t) => t.mime === (mime ?? "").toLowerCase()) ?? null;
}

export const labelOf = (mime: string) => ATTACHMENT_TYPES.find((t) => t.mime === mime)?.label ?? "File";
export const isAllowedMime = (mime: string) => ATTACHMENT_TYPES.some((t) => t.mime === mime);

/** "340 KB", "1.2 MB". */
export function sizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/** A file's name as it will be shown and saved under: no folders, no control characters, no leading dots, cut to a sensible length with the extension kept. */
export function safeName(raw: string | null | undefined): string {
  let n = (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).pop() ?? "";
  n = n.replace(/[<>:"|?*]/g, "_").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  if (!n) return "file";
  if (n.length > FILE_NAME_MAX) {
    const e = extOf(n);
    const keep = FILE_NAME_MAX - (e ? e.length + 1 : 0);
    n = `${n.slice(0, Math.max(1, keep)).trimEnd()}${e ? `.${e}` : ""}`;
  }
  return n;
}

export type CheckCode = "empty" | "too_big" | "type" | "mismatch" | "unsafe" | "unreadable";
export type Checked = { ok: true; type: AttachmentType; data: Uint8Array; name: string } | { ok: false; code: CheckCode; error: string };

export const REFUSAL: Record<CheckCode, string> = {
  empty: "That file is empty.",
  too_big: `That file is over ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB.`,
  type: "That kind of file can't be sent here. You can send pictures, PDF, Word, Excel, CSV and text files.",
  mismatch: "That file is not what its name says it is, so it was not kept.",
  unsafe: "That file carries a script or a macro, so it was not kept.",
  unreadable: "That file could not be read."
};

const fail = (code: CheckCode, name: string): Checked => ({ ok: false, code, error: `${safeName(name)}: ${REFUSAL[code]}` });

const startsWith = (d: Uint8Array, sig: number[], at = 0) => sig.every((b, i) => d[at + i] === b);
const latin1 = (d: Uint8Array) => {
  let s = "";
  for (let i = 0; i < d.length; i += 8192) s += String.fromCharCode(...d.subarray(i, Math.min(d.length, i + 8192)));
  return s;
};

/** A JPEG without its EXIF/XMP (APP1), IPTC (APP13) and comment segments: where the photo was taken and with what. Null when the bytes are not a well-formed JPEG. */
export function stripJpeg(d: Uint8Array): Uint8Array | null {
  if (!startsWith(d, [0xff, 0xd8])) return null;
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i < d.length) {
    if (d[i] !== 0xff) return null;
    while (d[i] === 0xff && i < d.length) i += 1; // fill bytes
    const marker = d[i]!;
    i += 1;
    if (marker === 0xd9) {
      out.push(0xff, 0xd9);
      return Uint8Array.from(out);
    }
    if (marker === 0xda) {
      // Start of scan: the rest is image data up to the end, kept as it is.
      out.push(0xff, 0xda);
      for (let k = i; k < d.length; k += 1) out.push(d[k]!);
      return Uint8Array.from(out);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(0xff, marker);
      continue;
    }
    if (i + 2 > d.length) return null;
    const len = (d[i]! << 8) | d[i + 1]!;
    if (len < 2 || i + len > d.length) return null;
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!drop) {
      out.push(0xff, marker);
      for (let k = i; k < i + len; k += 1) out.push(d[k]!);
    }
    i += len;
  }
  return null;
}

const PNG_DROP = new Set(["tEXt", "iTXt", "zTXt", "eXIf", "tIME"]);

/** A PNG without its text, EXIF and time chunks. Null when the bytes are not a well-formed PNG. */
export function stripPng(d: Uint8Array): Uint8Array | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!startsWith(d, sig)) return null;
  const out: number[] = [...sig];
  let i = 8;
  let ended = false;
  while (i + 12 <= d.length) {
    const len = ((d[i]! << 24) | (d[i + 1]! << 16) | (d[i + 2]! << 8) | d[i + 3]!) >>> 0;
    const type = String.fromCharCode(d[i + 4]!, d[i + 5]!, d[i + 6]!, d[i + 7]!);
    const end = i + 12 + len;
    if (end > d.length) return null;
    if (!PNG_DROP.has(type)) for (let k = i; k < end; k += 1) out.push(d[k]!);
    i = end;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  return ended ? Uint8Array.from(out) : null;
}

/**
 * Judge a file. Size and emptiness first, then the type by name, then the bytes themselves: they must start the way that type starts, and a document must not carry
 * script (a PDF's /JavaScript, /JS, /Launch) or macros (an Office file's vbaProject). A photo comes back with its metadata removed.
 */
export function checkAttachment(name: string | null | undefined, mime: string | null | undefined, data: Uint8Array): Checked {
  const shown = safeName(name);
  if (data.length === 0) return fail("empty", shown);
  if (data.length > ATTACHMENT_MAX_BYTES) return fail("too_big", shown);
  const type = typeOf(name, mime);
  if (!type) return fail("type", shown);

  switch (type.mime) {
    case "application/pdf": {
      if (!startsWith(data, [0x25, 0x50, 0x44, 0x46, 0x2d])) return fail("mismatch", shown); // %PDF-
      if (/\/(JavaScript|Launch|EmbeddedFile)\b|\/JS(?![A-Za-z])/.test(latin1(data))) return fail("unsafe", shown);
      return { ok: true, type, data, name: shown };
    }
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
      if (!startsWith(data, [0x50, 0x4b, 0x03, 0x04])) return fail("mismatch", shown); // PK..
      const text = latin1(data);
      const root = type.label === "Word" ? "word/" : "xl/";
      if (!text.includes("[Content_Types].xml") || !text.includes(root)) return fail("mismatch", shown);
      if (/vbaProject|macrosheets\//i.test(text)) return fail("unsafe", shown);
      return { ok: true, type, data, name: shown };
    }
    case "text/csv":
    case "text/plain": {
      if (data.subarray(0, 8192).includes(0)) return fail("mismatch", shown);
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        return fail("unreadable", shown);
      }
      return { ok: true, type, data, name: shown };
    }
    case "image/jpeg": {
      if (!startsWith(data, [0xff, 0xd8, 0xff])) return fail("mismatch", shown);
      const clean = stripJpeg(data);
      return clean ? { ok: true, type, data: clean, name: shown } : fail("unreadable", shown);
    }
    case "image/png": {
      const clean = stripPng(data);
      if (!startsWith(data, [0x89, 0x50, 0x4e, 0x47])) return fail("mismatch", shown);
      return clean ? { ok: true, type, data: clean, name: shown } : fail("unreadable", shown);
    }
    case "image/webp": {
      if (!(startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8))) return fail("mismatch", shown); // RIFF....WEBP
      return { ok: true, type, data, name: shown };
    }
    default:
      return fail("type", shown);
  }
}

/** "Photo", "2 photos", "PDF: bol.pdf", "Photo and file": a short line about what a message carries, for a thread list and a screen reader. */
export function summaryOf(list: ReadonlyArray<{ kind: string; name: string | null; mime: string }>): string {
  const photos = list.filter((a) => a.kind === "image").length;
  const files = list.filter((a) => a.kind !== "image");
  const parts: string[] = [];
  if (photos === 1) parts.push("Photo");
  else if (photos > 1) parts.push(`${photos} photos`);
  if (files.length === 1) parts.push(`${labelOf(files[0]!.mime)}: ${(files[0]!.name ?? "").trim() || "file"}`);
  else if (files.length > 1) parts.push(`${files.length} files`);
  return parts.length === 2 && photos > 0 && files.length > 0 ? `${parts[0]} and ${files.length === 1 ? "file" : "files"}` : parts.join(" and ");
}

// ───────────────────────────── links ─────────────────────────────

export type LinkPart = { kind: "text"; text: string } | { kind: "link"; text: string; url: string; host: string };

const CANDIDATE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

/** Take trailing punctuation off an address: a full stop at the end of a sentence is not part of it, and a closing bracket only is when it has an opener. */
function trim(raw: string): string {
  let u = raw;
  for (;;) {
    const last = u[u.length - 1];
    if (!last) return u;
    if (/[.,;:!?'"\]}]/.test(last)) u = u.slice(0, -1);
    else if (last === ")") {
      const opens = (u.match(/\(/g) ?? []).length;
      const closes = (u.match(/\)/g) ?? []).length;
      if (closes > opens) u = u.slice(0, -1);
      else return u;
    } else return u;
  }
}

/** A web address a message may link to: http or https, a real host, no embedded login (user:password@ is how a fake address is dressed up). Null otherwise. */
export function safeLink(raw: string): { url: string; host: string } | null {
  const withScheme = /^www\./i.test(raw) ? `https://${raw}` : raw;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.replace(/^www\./i, "");
  if (!host || !host.includes(".")) return null;
  return { url: u.toString(), host };
}

/** A message's words split into plain text and links, in order. Only addresses that pass `safeLink` become links; everything else stays text. */
export function linkParts(text: string): LinkPart[] {
  const parts: LinkPart[] = [];
  let at = 0;
  const re = new RegExp(CANDIDATE.source, CANDIDATE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const shown = trim(m[0]);
    const ok = safeLink(shown);
    if (!ok) continue;
    if (m.index > at) parts.push({ kind: "text", text: text.slice(at, m.index) });
    parts.push({ kind: "link", text: shown, url: ok.url, host: ok.host });
    at = m.index + shown.length;
    re.lastIndex = at;
  }
  if (at < text.length) parts.push({ kind: "text", text: text.slice(at) });
  return parts.length > 0 ? parts : [{ kind: "text", text }];
}
