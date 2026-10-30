import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENTS_PER_MESSAGE,
  ATTACHMENT_MAX_BYTES,
  checkAttachment,
  linkParts,
  safeLink,
  safeName,
  sizeLabel,
  stripJpeg,
  stripPng,
  summaryOf,
  typeOf
} from "../src/lib/attachments";

const bytes = (s: string) => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0) & 0xff));
const cat = (...parts: Array<number[] | Uint8Array>) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const text = (d: Uint8Array) => String.fromCharCode(...d);

const PDF = bytes("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF");
const zipish = (inner: string) => bytes(`PK\x03\x04[Content_Types].xml ${inner}`);

// A JPEG with a camera/location segment (APP1, "Exif") and a comment: start, APP0, APP1, COM, DQT, scan, end.
const JPEG_WITH_EXIF = cat(
  [0xff, 0xd8],
  [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46],
  [0xff, 0xe1, 0x00, 0x0a, ...ascii("Exif"), 0, 0, ...ascii("GP")],
  [0xff, 0xfe, 0x00, 0x05, ...ascii("hi!")],
  [0xff, 0xdb, 0x00, 0x04, 0x00, 0x00],
  [0xff, 0xda, 0x00, 0x02, 1, 2, 3],
  [0xff, 0xd9]
);

const chunk = (type: string, data: number[]) => [0, 0, 0, data.length, ...ascii(type), ...data, 0, 0, 0, 0];
const PNG_WITH_TEXT = cat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], chunk("IHDR", new Array(13).fill(1)), chunk("tEXt", ascii("GPS\0here")), chunk("IDAT", [1, 2, 3]), chunk("IEND", []));

describe("what can be sent", () => {
  it("lists the phone's types and decides by the extension", () => {
    expect(typeOf("bol.PDF")?.label).toBe("PDF");
    expect(typeOf("rates.xlsx")?.label).toBe("Excel");
    expect(typeOf("photo.jpeg")?.mime).toBe("image/jpeg");
    expect(typeOf("run.exe", "application/pdf")).toBeNull(); // an extension that is not ours is not ours, whatever the device says
    expect(typeOf("old.doc")).toBeNull(); // the macro-capable formats are not allowed
    expect(typeOf("old.xls")).toBeNull();
    expect(typeOf("noext", "application/pdf")?.label).toBe("PDF");
  });
  it("matches the phone's limits", () => {
    expect(ATTACHMENTS_PER_MESSAGE).toBe(4);
    expect(ATTACHMENT_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
  it("names and sizes files readably", () => {
    expect(safeName("..\\..\\etc/passwd")).toBe("passwd");
    expect(safeName("  .hidden.pdf ")).toBe("hidden.pdf");
    expect(safeName("")).toBe("file");
    expect(safeName(`${"a".repeat(300)}.pdf`).endsWith(".pdf")).toBe(true);
    expect(safeName(`${"a".repeat(300)}.pdf`).length).toBeLessThanOrEqual(120);
    expect(sizeLabel(340 * 1024)).toBe("340 KB");
    expect(sizeLabel(1.2 * 1024 * 1024)).toBe("1.2 MB");
  });
});

describe("a file is judged by what it is, not what it is called", () => {
  it("keeps a plain PDF", () => {
    const r = checkAttachment("bol.pdf", "application/pdf", PDF);
    expect(r.ok).toBe(true);
  });
  it("refuses a program renamed .pdf", () => {
    const r = checkAttachment("invoice.pdf", "application/pdf", bytes("MZ\x90\x00 this is a program"));
    expect(r).toMatchObject({ ok: false, code: "mismatch" });
  });
  it("refuses a PDF that carries script", () => {
    for (const evil of ["/JavaScript (app.alert(1))", "/JS (x)", "/Launch /Win", "/EmbeddedFile"]) {
      const r = checkAttachment("x.pdf", "application/pdf", bytes(`%PDF-1.4\n<< ${evil} >>`));
      expect(r, evil).toMatchObject({ ok: false, code: "unsafe" });
    }
  });
  it("does not mistake an ordinary word for script", () => {
    expect(checkAttachment("x.pdf", "application/pdf", bytes("%PDF-1.4\n<< /Subtype /JSON-ish /JSX >>")).ok).toBe(true);
  });
  it("keeps a Word or Excel file and refuses one with macros", () => {
    expect(checkAttachment("a.docx", "", zipish("word/document.xml")).ok).toBe(true);
    expect(checkAttachment("a.xlsx", "", zipish("xl/workbook.xml")).ok).toBe(true);
    expect(checkAttachment("a.docx", "", zipish("word/document.xml word/vbaProject.bin")) ).toMatchObject({ ok: false, code: "unsafe" });
    expect(checkAttachment("a.xlsx", "", zipish("xl/workbook.xml xl/macrosheets/sheet1.xml"))).toMatchObject({ ok: false, code: "unsafe" });
    // a zip that is neither is not an Office file
    expect(checkAttachment("a.docx", "", zipish("readme.txt"))).toMatchObject({ ok: false, code: "mismatch" });
    expect(checkAttachment("a.xlsx", "", bytes("not a zip at all"))).toMatchObject({ ok: false, code: "mismatch" });
  });
  it("keeps text and CSV, and refuses binary or broken text", () => {
    expect(checkAttachment("r.csv", "", bytes("a,b\n1,2\n")).ok).toBe(true);
    expect(checkAttachment("r.txt", "", bytes("hello")).ok).toBe(true);
    expect(checkAttachment("r.csv", "", Uint8Array.from([97, 0, 98]))).toMatchObject({ ok: false, code: "mismatch" });
    expect(checkAttachment("r.txt", "", Uint8Array.from([0xff, 0xfe, 0xfd, 0x41]))).toMatchObject({ ok: false, code: "unreadable" });
  });
  it("refuses empty, over-size and unknown types", () => {
    expect(checkAttachment("a.pdf", "", new Uint8Array(0))).toMatchObject({ ok: false, code: "empty" });
    expect(checkAttachment("a.pdf", "", new Uint8Array(ATTACHMENT_MAX_BYTES + 1))).toMatchObject({ ok: false, code: "too_big" });
    expect(checkAttachment("a.pdf", "", new Uint8Array(ATTACHMENT_MAX_BYTES).fill(0x20)).ok).toBe(false); // right size, but not a PDF
    expect(checkAttachment("tool.exe", "application/octet-stream", bytes("MZ"))).toMatchObject({ ok: false, code: "type" });
  });
  it("names the file in the refusal so the sender knows which one", () => {
    const r = checkAttachment("bad.pdf", "", bytes("nope"));
    expect(r.ok ? "" : r.error).toContain("bad.pdf");
  });
});

describe("photos lose where they were taken", () => {
  it("removes the EXIF and comment segments from a JPEG and leaves a valid file", () => {
    const out = stripJpeg(JPEG_WITH_EXIF)!;
    expect(out).not.toBeNull();
    expect(text(out)).not.toContain("Exif");
    expect(text(out)).not.toContain("hi!");
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
    expect(out[out.length - 2]).toBe(0xff);
    expect(out[out.length - 1]).toBe(0xd9);
    expect(text(out)).toContain("JF"); // the ordinary header segment stays
    expect(Array.from(out.subarray(out.length - 9))).toEqual([0xff, 0xda, 0x00, 0x02, 1, 2, 3, 0xff, 0xd9]); // the scan and its data are untouched
  });
  it("checkAttachment hands back the cleaned JPEG, not the original", () => {
    const r = checkAttachment("p.jpg", "image/jpeg", JPEG_WITH_EXIF);
    expect(r.ok && text(r.data)).not.toContain("Exif");
  });
  it("removes text chunks from a PNG and keeps the picture chunks", () => {
    const out = stripPng(PNG_WITH_TEXT)!;
    expect(out).not.toBeNull();
    expect(text(out)).not.toContain("tEXt");
    expect(text(out)).not.toContain("GPS");
    expect(text(out)).toContain("IHDR");
    expect(text(out)).toContain("IDAT");
    expect(text(out)).toContain("IEND");
  });
  it("refuses a truncated or mislabelled picture", () => {
    expect(stripJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff, 1, 2]))).toBeNull();
    expect(stripPng(PNG_WITH_TEXT.subarray(0, 40))).toBeNull();
    expect(checkAttachment("p.png", "", bytes("not a picture"))).toMatchObject({ ok: false, code: "mismatch" });
    expect(checkAttachment("p.jpg", "", bytes("GIF89a"))).toMatchObject({ ok: false, code: "mismatch" });
  });
  it("keeps a WebP by its RIFF header", () => {
    expect(checkAttachment("p.webp", "", bytes("RIFF\x10\x00\x00\x00WEBPVP8 ")).ok).toBe(true);
    expect(checkAttachment("p.webp", "", bytes("RIFF\x10\x00\x00\x00WAVEfmt ")).ok).toBe(false);
  });
});

describe("what a message carries, in a line", () => {
  it("summarises pictures and files", () => {
    expect(summaryOf([{ kind: "image", name: null, mime: "image/jpeg" }])).toBe("Photo");
    expect(summaryOf([{ kind: "image", name: null, mime: "image/jpeg" }, { kind: "image", name: null, mime: "image/png" }])).toBe("2 photos");
    expect(summaryOf([{ kind: "file", name: "bol.pdf", mime: "application/pdf" }])).toBe("PDF: bol.pdf");
    expect(summaryOf([{ kind: "image", name: null, mime: "image/jpeg" }, { kind: "file", name: "bol.pdf", mime: "application/pdf" }])).toBe("Photo and file");
    expect(summaryOf([])).toBe("");
  });
});

describe("links", () => {
  const links = (s: string) => linkParts(s).filter((p) => p.kind === "link").map((p) => (p.kind === "link" ? p.url : ""));
  it("finds web addresses and leaves a sentence's full stop out", () => {
    expect(links("See https://example.com/bol.pdf.")).toEqual(["https://example.com/bol.pdf"]);
    expect(links("Dock map: https://maps.example.com/a?x=1&y=2, then call")).toEqual(["https://maps.example.com/a?x=1&y=2"]);
    expect(links("(https://example.com/a)")).toEqual(["https://example.com/a"]);
    expect(links("https://example.com/wiki/Foo_(bar)")).toEqual(["https://example.com/wiki/Foo_(bar)"]);
  });
  it("accepts a bare www address and shows the host without www", () => {
    const p = linkParts("go to www.example.com now").find((x) => x.kind === "link");
    expect(p).toMatchObject({ kind: "link", url: "https://www.example.com/", host: "example.com" });
  });
  it("never links another scheme, an address with a login in it, or a name with no dot", () => {
    expect(links("javascript:alert(1)")).toEqual([]);
    expect(links("data:text/html,<b>x</b>")).toEqual([]);
    expect(links("ftp://example.com/a")).toEqual([]);
    expect(links("https://paypal.com@evil.example/login")).toEqual([]);
    expect(links("https://localhost/x")).toEqual([]);
    expect(safeLink("http://example.com")).toEqual({ url: "http://example.com/", host: "example.com" });
  });
  it("keeps all the words, in order, whether or not there is a link", () => {
    const parts = linkParts("a https://example.com b");
    expect(parts.map((p) => p.text).join("")).toBe("a https://example.com b");
    expect(linkParts("no links here")).toEqual([{ kind: "text", text: "no links here" }]);
  });
});

describe("where the bytes go", () => {
  const src = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  it("the file route checks the workspace and forbids guessing a type", () => {
    const route = src("src/app/(desk)/messages/file/[id]/route.ts");
    expect(route).toContain("currentWorkspaceId()");
    expect(route).toContain("nosniff");
    expect(route).toContain("isAllowedMime");
    expect(route).toMatch(/attachment; filename|"attachment"/);
  });
  it("storage keys are made by the desk, never taken from a name the sender chose", () => {
    const store = src("src/server/tl/message-files.ts");
    expect(store).toContain("randomUUID()");
    expect(store).toContain("SAFE_KEY");
  });
  it("the send route judges every file before keeping any", () => {
    const route = src("src/app/(desk)/messages/send/route.ts");
    expect(route.indexOf("checkAttachment")).toBeGreaterThan(-1);
    expect(route.indexOf("problems.length > 0")).toBeLessThan(route.indexOf("sendMessage("));
  });
});
