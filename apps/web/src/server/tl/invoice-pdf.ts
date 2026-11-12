import type { Terminals } from "@/lib/scope";
import { prisma } from "@/lib/db";
import { buildInvoicePdf, type InvoicePdfData } from "@/lib/invoice-pdf";
import { termsLabel } from "@/lib/invoicing";
import { dueAt } from "@/lib/overdue";
import { balanceOf, invoiceStateLabel } from "@/lib/invoice-records";
import { providerName } from "@/server/partners/call";
import { toCompany } from "./company";
import { getInvoice } from "./invoicing";
import { inTerminal } from "./terminal-sql";
import { currentWorkspaceId } from "./workspace";
import { workspaceTimezone } from "./zone";

/**
 * What goes on the invoice PDF for a load, from its invoice record (one load or several, credits and payments kept apart), or for an imported invoice with no record
 * (gap 16) from the load's own fields as before. Null when the load has no invoice or is outside the person's terminals.
 */
export async function invoicePdfData(loadId: string, workspaceId = currentWorkspaceId(), terminal: Terminals = null): Promise<InvoicePdfData | null> {
  const visible = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, ...inTerminal(terminal) }, select: { id: true } });
  if (!visible) return null;
  const tz = await workspaceTimezone(workspaceId);
  const day = (d: Date | null | undefined) => (d ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: tz }).format(d) : null);
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!ws) return null;
  const company = toCompany(ws);
  const issuer = { name: company.name, address: company.address, mc: company.mcNumber, dot: company.dotNumber, phone: company.phone, email: company.email, remitTo: company.remitTo, paymentNote: company.paymentNote };

  const rec = await prisma.invoice.findFirst({
    where: { workspaceId, kind: "invoice", loads: { some: { loadId } } },
    orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
    include: { lines: { orderBy: { sort: "asc" } }, loads: true, payments: true }
  });
  if (rec) {
    const loads = await prisma.load.findMany({
      where: { id: { in: rec.loads.map((l) => l.loadId) } },
      select: { id: true, loadNumber: true, poNumber: true, originAddress: true, destinationAddress: true, completedAt: true, stops: { orderBy: { stopSequence: "asc" }, select: { arrivedAt: true, stopRole: true, stopType: true, referenceNumbers: true } } }
    });
    const order: string[] = [];
    for (const l of rec.lines) if (l.loadId && !order.includes(l.loadId)) order.push(l.loadId);
    for (const l of rec.loads) if (!order.includes(l.loadId)) order.push(l.loadId);
    const byId = new Map(loads.map((l) => [l.id, l]));
    const credited = rec.payments.filter((p) => p.source === "credit").reduce((s, p) => s + p.amount.toNumber(), 0);
    const received = rec.payments.filter((p) => p.source !== "credit").reduce((s, p) => s + p.amount.toNumber(), 0);
    const status = rec.status as "open" | "paid" | "void";
    let factoring: InvoicePdfData["factoring"] = null;
    if (rec.factoringStatus !== "none" && rec.factoringStatus !== "rejected") {
      const conn = await prisma.partnerConnection.findFirst({ where: { workspaceId, capability: "factoring" }, select: { provider: true, accountLabel: true } });
      factoring = { factor: conn ? conn.accountLabel || providerName(conn.provider) : "the factoring company", reference: rec.factoringReferenceId, remitTo: null };
    }
    return {
      kind: "invoice",
      number: rec.number,
      issued: day(rec.issuedAt)!,
      due: day(dueAt(rec.issuedAt, rec.termsDays) ?? rec.issuedAt),
      termsLabel: termsLabel(rec.termsDays),
      status: invoiceStateLabel({ total: rec.total, paidTotal: rec.paidTotal, status }),
      issuer,
      billTo: { name: rec.billToName, mc: rec.billToMc, email: rec.billToEmail, phone: rec.billToPhone },
      loads: order.map((id) => {
        const l = byId.get(id);
        const pickup = l?.stops.find((s) => (s.stopRole ?? s.stopType) === "pickup");
        return {
          loadNumber: l?.loadNumber ?? null,
          po: l?.poNumber ?? null,
          origin: l?.originAddress ?? null,
          destination: l?.destinationAddress ?? null,
          pickedUp: day(pickup?.arrivedAt),
          delivered: day(l?.completedAt),
          refs: (l?.stops ?? []).flatMap((s) => (Array.isArray(s.referenceNumbers) ? (s.referenceNumbers as unknown[]).map(String) : [])).slice(0, 12),
          lines: rec.lines.filter((x) => x.loadId === id).map((x) => ({ label: x.label, amount: x.amount.toNumber() }))
        };
      }),
      invoiceLines: rec.lines.filter((x) => !x.loadId).map((x) => ({ label: x.label, amount: x.amount.toNumber() })),
      total: rec.total.toNumber(),
      received,
      credited,
      // Credits are kept as payment rows of their own source, so what is received already counts them: the record's own rule says what is owed.
      balance: balanceOf({ total: rec.total, paidTotal: rec.paidTotal, status }),
      creditOf: null,
      factoring
    };
  }

  // Gap 16: an invoice with no record (imported history) prints from the load as it always did.
  const inv = await getInvoice(loadId, workspaceId, terminal);
  if (!inv) return null;
  return {
    kind: "invoice",
    number: inv.invoiceNumber ?? "Imported",
    issued: day(inv.sent)!,
    due: day(inv.due),
    termsLabel: termsLabel(inv.terms),
    status: inv.status === "paid" ? "Paid" : "Open",
    issuer,
    billTo: { name: inv.billTo.name, mc: inv.billTo.mc, email: inv.billTo.email, phone: inv.billTo.phone },
    loads: [{ loadNumber: inv.load.number, po: inv.load.po, origin: inv.load.origin, destination: inv.load.destination, pickedUp: null, delivered: day(inv.load.delivered), refs: inv.stops.flatMap((s) => s.refs).slice(0, 12), lines: inv.lines }],
    invoiceLines: [],
    total: inv.total,
    received: inv.paidAmount ?? 0,
    credited: 0,
    balance: inv.balance,
    creditOf: null,
    factoring: null
  };
}

export async function invoicePdf(loadId: string, workspaceId = currentWorkspaceId(), terminal: Terminals = null): Promise<{ filename: string; bytes: Uint8Array } | null> {
  const data = await invoicePdfData(loadId, workspaceId, terminal);
  if (!data) return null;
  const bytes = await buildInvoicePdf(data);
  return { filename: `${data.number.replace(/[^A-Za-z0-9._-]+/g, "_")}.pdf`, bytes };
}
