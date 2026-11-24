import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { checkAttachment } from "@/lib/attachments";
import { attachmentPathAllowed, fileNameOf } from "@/lib/driver-messages";
import { bridgeState, takeable } from "@/lib/driver-receipts";
import { removeFiles, storeFile } from "@/server/tl/message-files";
import { storageRefusal } from "@/server/tl/storage";
import { currentWorkspaceId } from "@/server/tl/workspace";
import type { BridgeTransport } from "./transport";

/** How far back the desk keeps telling the phone about a receipt. */
const TELL_DAYS = 120;

export type ReceiptPull = { taken: number; ignored: number; waiting: number; told: number };

/**
 * Receipts over the bridge (sync plan Step 5b). In: a row the desk has not taken becomes its own record with the photo in its own storage (checked like any upload), at least once and idempotent
 * (the bridge row id is the record's), then the row is stamped taken and the photo leaves the bridge. A photo that cannot be kept is named on the record; a link that does not answer leaves
 * the row for the next run. Out: what the phone should say about each receipt, written only when it changed.
 */
export async function syncDriverReceipts(transport: BridgeTransport, opts: { workspaceId?: string; now?: Date } = {}): Promise<ReceiptPull> {
  const workspaceId = opts.workspaceId ?? currentWorkspaceId();
  const now = opts.now ?? new Date();
  const res: ReceiptPull = { taken: 0, ignored: 0, waiting: 0, told: 0 };
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { bridgeOrgId: true } });
  if (!ws?.bridgeOrgId) return res;
  const orgId = ws.bridgeOrgId;

  for (const row of await transport.receiptsToTake(orgId, 100)) {
    const driver = takeable(row, orgId) ? await prisma.driver.findFirst({ where: { workspaceId, phoneUserId: row.driver_sub }, select: { id: true } }) : null;
    if (!driver) {
      res.ignored += 1;
      continue;
    }
    const there = await prisma.driverReceipt.findUnique({ where: { bridgeId: row.id }, select: { id: true } });
    if (!there) {
      let photo: Awaited<ReturnType<typeof storeFile>> | null = null;
      let missing: string | null = null;
      if (!attachmentPathAllowed(orgId, row.driver_sub, row.path)) missing = "it was outside the driver's folder";
      else {
        let data: Uint8Array | null = null;
        try {
          data = await transport.downloadDriverFile(row.path);
        } catch (e) {
          if ((e as { code?: string }).code === "unreachable") {
            res.waiting += 1;
            continue;
          }
        }
        const c = data ? checkAttachment(fileNameOf(row.path), "image/jpeg", data) : null;
        if (!data) missing = "it was no longer on the phone link";
        else if (!c!.ok) missing = "the desk's file checks refused it";
        else if (await storageRefusal(c!.data.length, workspaceId)) missing = "this desk's storage is full";
        else photo = await storeFile(workspaceId, c!);
      }
      const load = row.source_load_id ? await prisma.load.findFirst({ where: { id: row.source_load_id, workspaceId }, select: { id: true } }) : null;
      try {
        await prisma.driverReceipt.create({
          data: {
            workspaceId,
            driverId: driver.id,
            bridgeId: row.id,
            loadId: load?.id ?? null,
            kind: row.kind,
            amount: new Prisma.Decimal(row.amount_cents).div(100),
            spentOn: new Date(`${row.spent_on}T00:00:00Z`),
            note: row.note?.slice(0, 200) ?? null,
            sentAt: new Date(row.created_at),
            storageKey: photo?.storageKey ?? null,
            mime: photo?.mime ?? null,
            bytes: photo?.bytes ?? 0,
            photoMissing: missing
          }
        });
      } catch (e) {
        if (photo) await removeFiles([photo.storageKey]);
        // Another run took it a moment ago: its copy stands.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      }
    }
    if (attachmentPathAllowed(orgId, row.driver_sub, row.path)) await transport.removeDriverFiles([row.path]);
    await transport.patchReceipt(orgId, row.id, { taken_at: now.toISOString() });
    res.taken += 1;
  }

  const since = new Date(now.getTime() - TELL_DAYS * 86_400_000);
  const mine = await prisma.driverReceipt.findMany({ where: { workspaceId, sentAt: { gte: since } }, select: { bridgeId: true, state: true, reason: true, settlement: { select: { number: true, paidAt: true } } } });
  const there = new Map((await transport.receiptStates(orgId, since)).map((r) => [r.id, r]));
  for (const r of mine) {
    const b = there.get(r.bridgeId);
    if (!b) continue;
    const want = bridgeState(r);
    if (b.state === want.state && (b.reason ?? null) === want.reason && (b.statement_number ?? null) === want.statement_number) continue;
    await transport.patchReceipt(orgId, r.bridgeId, { ...want, updated_at: now.toISOString() });
    res.told += 1;
  }
  return res;
}
