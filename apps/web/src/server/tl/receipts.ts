import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { usd } from "@/lib/desk-format";
import { MAX_REASON, MIN_REASON, RECEIPT_LABEL, reimbursedLabel, type ReceiptKind, type ReceiptState } from "@/lib/driver-receipts";
import { inScope, terminalFilter, type Terminals } from "@/lib/scope";
import { recordAudit } from "./audit";
import { currentActor } from "./identity";
import { currentAllowed } from "./scope";
import { currentWorkspaceId } from "./workspace";

/**
 * Receipts drivers sent from their phones (sync plan Step 5b): the queue, the decision, and what an approved one puts on a statement. Approving is the whole decision: the receipt goes on
 * the driver's next statement by itself as a reimbursement line (lib/settlement.ts), which is money back, never pay. It is tied to the statement that finalizes it and freed if that is voided.
 */
type Db = Prisma.TransactionClient | typeof prisma;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export type ReceiptView = {
  id: string;
  driverId: string;
  driverName: string;
  kind: ReceiptKind;
  amount: number;
  spentOn: string;
  note: string | null;
  load: { id: string; number: string | null } | null;
  state: ReceiptState;
  reason: string | null;
  decidedBy: string | null;
  sentAt: Date;
  hasPhoto: boolean;
  photoMissing: string | null;
  statement: { id: string; number: string } | null;
};

const SHOWN_DECIDED = 15;

/** Waiting ones, oldest first, then the last decided. Only drivers of terminals the person may see. */
export async function receiptQueue(workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<{ waiting: ReceiptView[]; decided: ReceiptView[] }> {
  const al = allowed !== undefined ? allowed : await currentAllowed(workspaceId);
  const where = { workspaceId, ...(al == null ? {} : { driver: { terminal: terminalFilter(al) } }) };
  const include = { driver: { select: { name: true } }, load: { select: { id: true, loadNumber: true } }, settlement: { select: { id: true, number: true } } };
  const [waiting, decided] = await Promise.all([
    prisma.driverReceipt.findMany({ where: { ...where, state: "submitted" }, include, orderBy: [{ sentAt: "asc" }, { id: "asc" }], take: 200 }),
    prisma.driverReceipt.findMany({ where: { ...where, state: { not: "submitted" } }, include, orderBy: [{ decidedAt: "desc" }, { id: "asc" }], take: SHOWN_DECIDED })
  ]);
  const view = (r: (typeof waiting)[number]): ReceiptView => ({
    id: r.id,
    driverId: r.driverId,
    driverName: r.driver.name,
    kind: r.kind as ReceiptKind,
    amount: new Prisma.Decimal(r.amount).toNumber(),
    spentOn: ymd(r.spentOn),
    note: r.note,
    load: r.load ? { id: r.load.id, number: r.load.loadNumber } : null,
    state: r.state as ReceiptState,
    reason: r.reason,
    decidedBy: r.decidedBy,
    sentAt: r.sentAt,
    hasPhoto: r.storageKey != null,
    photoMissing: r.photoMissing,
    statement: r.settlement
  });
  return { waiting: waiting.map(view), decided: decided.map(view) };
}

export type ReceiptResult = { ok: true } | { ok: false; error: string };

/** Approve, decline (with a reason the driver reads), or put a decision back. Nothing on a final statement changes. */
export async function decideReceipt(id: string, to: ReceiptState, reason: string | null = null, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<ReceiptResult> {
  if (!["submitted", "approved", "declined"].includes(to)) return { ok: false, error: "Pick what to do with the receipt." };
  const why = (reason ?? "").replace(/\s+/g, " ").trim();
  if (to === "declined" && why.length < MIN_REASON) return { ok: false, error: "Say why: the driver reads it on their phone." };
  if (why.length > MAX_REASON) return { ok: false, error: `${MAX_REASON} characters at most.` };
  const r = await prisma.driverReceipt.findFirst({ where: { id, workspaceId }, include: { driver: { select: { name: true, terminal: true } }, settlement: { select: { number: true } } } });
  const al = allowed !== undefined ? allowed : await currentAllowed(workspaceId);
  if (!r || !inScope(al, r.driver.terminal)) return { ok: false, error: "That receipt does not exist." };
  if (r.settlement) return { ok: false, error: `It is on ${r.settlement.number}, which is final. Void that statement to change it.` };
  if (r.state === to) return { ok: true };
  if (to !== "submitted" && r.state !== "submitted") return { ok: false, error: "It was already decided. Put it back first." };
  const what = `${r.driver.name}'s ${RECEIPT_LABEL[r.kind as ReceiptKind].toLowerCase()} receipt for ${usd(new Prisma.Decimal(r.amount).toNumber(), 2)}`;
  const done = await prisma.$transaction(async (tx) => {
    const out = await tx.driverReceipt.updateMany({ where: { id, workspaceId, state: r.state, settlementId: null }, data: to === "submitted" ? { state: to, reason: null, decidedBy: null, decidedAt: null } : { state: to, reason: to === "declined" ? why : null, decidedBy: currentActor(), decidedAt: now } });
    if (out.count !== 1) return false;
    await recordAudit({ entity: "settlement", action: "receipt_decided", loadId: r.loadId, summary: to === "approved" ? `${what} approved: it goes on their next statement` : to === "declined" ? `${what} declined` : `${what} put back to be decided`, reason: to === "declined" ? why : null, before: { Receipt: r.state }, after: { Receipt: to }, at: now, workspaceId }, tx);
    return true;
  });
  return done ? { ok: true } : { ok: false, error: "Someone else just changed it. Reload the page." };
}

export type Reimbursement = { receiptId: string; label: string; amount: number };

/** Per driver, the approved receipts on no final statement: what a draft carries. */
export async function openReimbursements(db: Db, workspaceId: string, driverIds: readonly string[]): Promise<Map<string, Reimbursement[]>> {
  const out = new Map<string, Reimbursement[]>(driverIds.map((d) => [d, []]));
  if (driverIds.length === 0) return out;
  const rows = await db.driverReceipt.findMany({ where: { workspaceId, driverId: { in: [...driverIds] }, state: "approved", settlementId: null }, orderBy: [{ spentOn: "asc" }, { id: "asc" }] });
  for (const r of rows) out.get(r.driverId)!.push({ receiptId: r.id, label: reimbursedLabel({ kind: r.kind, spentOn: ymd(r.spentOn) }), amount: new Prisma.Decimal(r.amount).toNumber() });
  return out;
}
