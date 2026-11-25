import { PDFDocument } from "pdf-lib";
import type { Terminals } from "@/lib/scope";
import { prisma } from "@/lib/db";
import { podStopsMissing } from "@/server/tl/documents";
import { invoicePdf } from "@/server/tl/invoice-pdf";
import { readFile } from "@/server/tl/message-files";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { isPacketImage, normalizePacketImage } from "./packet-image";

/**
 * The factoring packet for one invoice (docs/MONEY_PLAN.md, rule B; what counts as on file is server/tl/documents.ts packetFiles, shared with the factoring view and the schedule): one PDF holding the invoice, then each load's rate confirmation, proof of delivery (every delivery stop covered), and lumper receipts, in that order, ready for a
 * factor to take by email or SFTP or direct broker billing. It is refused unless every load on the invoice has a rate confirmation and complete proof of delivery on file as an actual file (a delivery photo sent
 * from the driver's phone that was never kept as a document does not count), and unless the result is within the size a factor's mailbox takes. Every picture is fitted inside
 * 1600 pixels on its longest side and saved as a JPEG at quality 75 first (packet-image.ts), so phone photos do not push a packet over the limit.
 */
export const PACKET_LIMIT_BYTES = 15 * 1024 * 1024;

export type PacketOut = { ok: true; filename: string; bytes: Uint8Array; pages: number; included: string[] } | { ok: false; error: string };

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 36;

type Doc = { id: string; name: string; mime: string; storageKey: string; kind: string };

export async function buildPacket(
  loadId: string,
  workspaceId = currentWorkspaceId(),
  terminal: Terminals = null,
  opts: { invoiceId?: string } = {}
): Promise<PacketOut> {
  const invoiceTargetId = opts.invoiceId?.trim() || null;
  let rec: { id: string; supplementOfId: string | null; loads: Array<{ loadId: string }>; lines: Array<{ loadId: string | null }> } | null = null;
  if (invoiceTargetId) {
    const found = await prisma.invoice.findFirst({
      where: { id: invoiceTargetId, workspaceId, kind: "invoice", status: { not: "void" } },
      select: {
        id: true,
        supplementOfId: true,
        loads: { select: { loadId: true } },
        lines: { select: { loadId: true } },
        supplementOf: { select: { loads: { select: { loadId: true } } } }
      }
    });
    if (!found) return { ok: false, error: "That invoice does not exist." };
    const parentLoadIds = found.supplementOf?.loads.map((l) => l.loadId) ?? [];
    const belongs =
      found.loads.some((l) => l.loadId === loadId) ||
      found.lines.some((l) => l.loadId === loadId) ||
      parentLoadIds.includes(loadId);
    if (!belongs) return { ok: false, error: "That invoice does not belong to this load." };
    rec = {
      id: found.id,
      supplementOfId: found.supplementOfId,
      loads: found.loads.length > 0 ? found.loads : parentLoadIds.map((id) => ({ loadId: id })),
      lines: found.lines
    };
  } else {
    rec = await prisma.invoice.findFirst({
      where: { workspaceId, kind: "invoice", supplementOfId: null, status: { not: "void" }, loads: { some: { loadId } } },
      include: { loads: true, lines: { select: { loadId: true } } },
      orderBy: [{ issuedAt: "desc" }, { id: "desc" }]
    });
  }
  const pdfKey = rec?.supplementOfId ? rec.id : loadId;
  const invoice = await invoicePdf(pdfKey, workspaceId, terminal);
  if (!invoice) return { ok: false, error: "That load has no invoice." };
  const lineLoads = rec ? [...new Set(rec.lines.map((l) => l.loadId).filter((x): x is string => !!x))] : [];
  const loadIds = rec
    ? rec.supplementOfId && lineLoads.length > 0
      ? lineLoads
      : rec.loads.length > 0
        ? rec.loads.map((l) => l.loadId)
        : [loadId]
    : [loadId];
  const [loads, rows, missingPods] = await Promise.all([
    prisma.load.findMany({ where: { id: { in: loadIds }, workspaceId, deletedAt: null }, select: { id: true, loadNumber: true } }),
    prisma.loadDocument.findMany({ where: { workspaceId, loadId: { in: loadIds }, kind: { in: ["rate_con", "pod", "lumper"] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, loadId: true, kind: true, name: true, mime: true, storageKey: true } }),
    podStopsMissing(loadIds, workspaceId)
  ]);
  const number = new Map(loads.map((l) => [l.id, l.loadNumber ?? "a load"]));

  const missing: string[] = [];
  const plan: Array<{ loadId: string; docs: Doc[] }> = [];
  for (const id of loadIds) {
    const mine = rows.filter((r) => r.loadId === id);
    const rate = mine.filter((r) => r.kind === "rate_con");
    const pod = mine.filter((r) => r.kind === "pod");
    const lumper = mine.filter((r) => r.kind === "lumper");
    if (rate.length === 0) missing.push(`${number.get(id) ?? "A load"}: rate confirmation`);
    const missingStops = missingPods.get(id);
    if (missingStops != null ? missingStops > 0 : pod.length === 0) missing.push(`${number.get(id) ?? "A load"}: proof of delivery`);
    plan.push({ loadId: id, docs: [...rate, ...pod, ...lumper] });
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
