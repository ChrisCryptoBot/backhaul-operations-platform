import { PDFDocument } from "pdf-lib";
import type { Terminals } from "@/lib/scope";
import { prisma } from "@/lib/db";
import { invoicePdf } from "@/server/tl/invoice-pdf";
import { readFile } from "@/server/tl/message-files";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { isPacketImage, normalizePacketImage } from "./packet-image";

/**
 * The factoring packet for one invoice (docs/MONEY_PLAN.md, rule B; what counts as on file is server/tl/documents.ts packetFiles, shared with the factoring view and the schedule): one PDF holding the invoice, then each load's rate confirmation and proof of delivery, in that order, ready for a
 * factor to take by email or SFTP. It is refused unless every load on the invoice has a rate confirmation and a proof of delivery on file as an actual file (a delivery photo sent
 * from the driver's phone that was never kept as a document does not count), and unless the result is within the size a factor's mailbox takes. Every picture is fitted inside
 * 1600 pixels on its longest side and saved as a JPEG at quality 75 first (packet-image.ts), so phone photos do not push a packet over the limit.
 */
export const PACKET_LIMIT_BYTES = 15 * 1024 * 1024;

export type PacketOut = { ok: true; filename: string; bytes: Uint8Array; pages: number; included: string[] } | { ok: false; error: string };

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 36;

type Doc = { id: string; name: string; mime: string; storageKey: string; kind: string };

export async function buildPacket(loadId: string, workspaceId = currentWorkspaceId(), terminal: Terminals = null): Promise<PacketOut> {
  const invoice = await invoicePdf(loadId, workspaceId, terminal);
  if (!invoice) return { ok: false, error: "That load has no invoice." };
  const rec = await prisma.invoice.findFirst({ where: { workspaceId, kind: "invoice", supplementOfId: null, status: { not: "void" }, loads: { some: { loadId } } }, include: { loads: true }, orderBy: [{ issuedAt: "desc" }, { id: "desc" }] });
  const loadIds = rec ? rec.loads.map((l) => l.loadId) : [loadId];
  const loads = await prisma.load.findMany({ where: { id: { in: loadIds }, workspaceId, deletedAt: null }, select: { id: true, loadNumber: true } });
  const number = new Map(loads.map((l) => [l.id, l.loadNumber ?? "a load"]));
  const rows = await prisma.loadDocument.findMany({ where: { workspaceId, loadId: { in: loadIds }, kind: { in: ["rate_con", "pod"] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, loadId: true, kind: true, name: true, mime: true, storageKey: true } });

  const missing: string[] = [];
  const plan: Array<{ loadId: string; docs: Doc[] }> = [];
  for (const id of loadIds) {
    const mine = rows.filter((r) => r.loadId === id);
    const rate = mine.filter((r) => r.kind === "rate_con");
    const pod = mine.filter((r) => r.kind === "pod");
    if (rate.length === 0) missing.push(`${number.get(id) ?? "A load"}: rate confirmation`);
    if (pod.length === 0) missing.push(`${number.get(id) ?? "A load"}: proof of delivery`);
    plan.push({ loadId: id, docs: [...rate, ...pod] });
  }
  if (missing.length > 0) return { ok: false, error: `The packet needs a file for each of these: ${missing.join("; ")}.` };

  const out = await PDFDocument.create();
  const add = async (bytes: Uint8Array | Buffer, mime: string, label: string): Promise<string | null> => {
    try {
      if (mime === "application/pdf") {
        const src = await PDFDocument.load(bytes);
        for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
        return null;
      }
      if (!isPacketImage(mime)) return `${label} is a ${mime || "file"} the packet cannot carry. Keep it as a PDF or a picture (JPEG, PNG, WebP, GIF, TIFF or AVIF); an iPhone HEIC photo needs saving as JPEG first.`;
      // Rule B: fitted inside the longest side and re-saved as JPEG, so a phone photo is a few hundred kilobytes, not several megabytes.
      const { jpeg } = await normalizePacketImage(bytes);
      const img = await out.embedJpg(jpeg);
      const page = out.addPage([PAGE_W, PAGE_H]);
      const scale = Math.min((PAGE_W - 2 * MARGIN) / img.width, (PAGE_H - 2 * MARGIN) / img.height, 1);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { x: (PAGE_W - w) / 2, y: PAGE_H - MARGIN - h, width: w, height: h });
      return null;
    } catch {
      return `${label} could not be read as a ${mime === "application/pdf" ? "PDF" : "picture"}. Upload it again.`;
    }
  };

  const included: string[] = [];
  const first = await add(invoice.bytes, "application/pdf", "The invoice");
  if (first) return { ok: false, error: first };
  included.push(`Invoice ${invoice.filename.replace(/\.pdf$/, "")}`);
  const problems: string[] = [];
  for (const group of plan) {
    for (const d of group.docs) {
      const label = `${number.get(group.loadId) ?? "A load"}: ${d.name}`;
      const data = await readFile(d.storageKey);
      if (!data) {
        problems.push(`${label} is missing from storage.`);
        continue;
      }
      const err = await add(data, d.mime, label);
      if (err) problems.push(err);
      else included.push(label);
    }
  }
  if (problems.length > 0) return { ok: false, error: problems.join(" ") };
  const bytes = await out.save();
  if (bytes.length > PACKET_LIMIT_BYTES) return { ok: false, error: `The packet is ${(bytes.length / 1048576).toFixed(1)} MB and a factor's mailbox takes ${PACKET_LIMIT_BYTES / 1048576} MB. Replace the largest photo with a smaller scan or a PDF.` };
  return { ok: true, filename: invoice.filename.replace(/\.pdf$/, "-packet.pdf"), bytes, pages: out.getPageCount(), included };
}
