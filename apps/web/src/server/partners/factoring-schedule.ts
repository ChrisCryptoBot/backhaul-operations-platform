import type { Terminals } from "@/lib/scope";
import { prisma } from "@/lib/db";
import { scheduleCsv, type ScheduleRow } from "@/lib/factoring-schedule";
import { balanceOf } from "@/lib/invoice-records";
import { dueAt } from "@/lib/overdue";
import { packetFiles } from "@/server/tl/documents";
import { inTerminal } from "@/server/tl/terminal-sql";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { workspaceTimezone } from "@/server/tl/zone";

/**
 * The schedule of accounts for the invoices a fleet could hand a factor now (docs/MONEY_PLAN.md, Wave 2): every open invoice that is not with a factor, one row each, with whether its
 * rate confirmation and proof of delivery are on file as files. Narrowed to the loads of the person's terminals. Capped, so one request cannot read a whole large book.
 */
export const SCHEDULE_CAP = 500;

export async function scheduleRows(workspaceId = currentWorkspaceId(), terminal: Terminals = null, only: string[] | null = null, invoiceIds: string[] | null = null): Promise<{ rows: ScheduleRow[]; cut: boolean }> {
  const tz = await workspaceTimezone(workspaceId);
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const invoices = await prisma.invoice.findMany({
    // Named invoices (a batch being built or sent again) are read whatever their factoring state; otherwise, the open invoices not with a factor.
    where: {
      workspaceId,
      kind: "invoice",
      ...(invoiceIds ? { id: { in: invoiceIds } } : { status: "open", factoringStatus: { in: ["none", "rejected"] } }),
      loads: { some: { ...(only ? { loadId: { in: only } } : {}), load: { is: { deletedAt: null, ...inTerminal(terminal) } } } }
    },
    orderBy: [{ issuedAt: "asc" }, { id: "asc" }],
    take: SCHEDULE_CAP + 1,
    include: { loads: true, lines: { select: { loadId: true, sort: true } } }
  });
  const cut = invoices.length > SCHEDULE_CAP;
  const shown = invoices.slice(0, SCHEDULE_CAP);
  const loadIds = [...new Set(shown.flatMap((i) => i.loads.map((l) => l.loadId)))];
  const loads = await prisma.load.findMany({ where: { id: { in: loadIds } }, select: { id: true, loadNumber: true, poNumber: true } });
  const byId = new Map(loads.map((l) => [l.id, l]));
  // The same rule as the factoring view and the packet (server/tl/documents.ts, packetFiles): only files kept on the load count.
  const files = await packetFiles(loadIds, workspaceId);
  const rows = shown.map((i): ScheduleRow => {
    // The invoice's loads in line order (the order its money is shared out in), then any without a line.
    const ordered = [...i.lines].sort((a, b) => a.sort - b.sort).map((l) => l.loadId).filter((id): id is string => !!id);
    const ids = [...new Set([...ordered, ...i.loads.map((l) => l.loadId)])];
    const mine = ids.map((id) => byId.get(id)).filter((l): l is NonNullable<typeof l> => !!l);
    const due = dueAt(i.issuedAt, i.termsDays);
    return {
      number: i.number,
      loads: mine.map((l) => l.loadNumber ?? "").filter(Boolean).join(", "),
      customer: i.billToName,
      mc: i.billToMc,
      po: mine.map((l) => l.poNumber).filter(Boolean).join(", ") || null,
      issued: day(i.issuedAt),
      due: due ? day(due) : null,
      termsDays: i.termsDays,
      amount: i.total.toNumber(),
      balance: balanceOf({ total: i.total, paidTotal: i.paidTotal, status: "open" }),
      rateCon: ids.every((id) => files.get(id)?.rateCon === true),
      pod: ids.every((id) => files.get(id)?.pod === true),
      reference: i.factoringReferenceId,
      invoiceId: i.id,
      loadIds: ids
    };
  });
  return { rows, cut };
}

export async function scheduleCsvFor(workspaceId = currentWorkspaceId(), terminal: Terminals = null, only: string[] | null = null): Promise<{ csv: string; count: number; cut: boolean }> {
  const { rows, cut } = await scheduleRows(workspaceId, terminal, only);
  return { csv: scheduleCsv(rows), count: rows.length, cut };
}
