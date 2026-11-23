import { prisma } from "@/lib/db";
import { AUTO_TO_DRIVER, CHOSEN_TO_DRIVER } from "@/lib/documents";
import { AFTER_DELIVERY_MS, documentPlan, filesOnPhone, rowsForLoad } from "@/lib/load-documents";
import { readFile } from "@/server/tl/message-files";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { BridgeTransportError, type BridgeTransport } from "./transport";

/**
 * The load-document mirror (sync plan Step 4), run from the bridge cron as the HOS mirror is: what each connected driver's phone should hold is worked out from the desk as it stands,
 * compared with what the bridge has, and only the difference is sent or removed. So adding a file, removing one, taking the driver off, a decline, a cancel, a relay and an unlink all
 * need nothing of their own. A file is uploaded before its row; a row is removed after its file. One file failing never stops the others, and is tried again on the next run.
 */
export async function mirrorLoadDocuments(transport: BridgeTransport, opts: { workspaceId?: string; now?: Date } = {}): Promise<{ sent: number; removed: number; failed: number }> {
  const workspaceId = opts.workspaceId ?? currentWorkspaceId();
  const now = opts.now ?? new Date();
  const out = { sent: 0, removed: 0, failed: 0 };
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { bridgeOrgId: true } });
  if (!ws?.bridgeOrgId) return out;
  const orgId = ws.bridgeOrgId;
  const since = new Date(now.getTime() - AFTER_DELIVERY_MS);
  const assignments = await prisma.assignment.findMany({
    where: {
      // The load really went to this phone.
      bridgeDispatchId: { not: null },
      driver: { active: true, phoneUserId: { not: null } },
      load: { workspaceId, deletedAt: null, documents: { some: { OR: [{ kind: { in: [...AUTO_TO_DRIVER] } }, { kind: CHOSEN_TO_DRIVER, toDriver: true }] } } },
      OR: [{ status: { in: ["dispatched", "accepted", "in_progress"] } }, { status: "completed", load: { completedAt: { gte: since } } }]
    },
    select: { status: true, driver: { select: { phoneUserId: true } }, load: { select: { id: true, status: true, completedAt: true, documents: { select: { id: true, kind: true, name: true, mime: true, bytes: true, sha256: true, toDriver: true } } } } }
  });
  const next = assignments
    .filter((a) => filesOnPhone({ assignment: a.status, load: a.load.status, completedAt: a.load.completedAt }, now))
    .flatMap((a) => rowsForLoad({ orgId, driverSub: a.driver.phoneUserId!, loadId: a.load.id, docs: a.load.documents }));
  const plan = documentPlan(next, await transport.loadDocumentRows(orgId));

  if (plan.remove.length > 0) {
    await transport.removeDriverFiles(plan.remove.map((r) => r.path));
    await transport.deleteLoadDocuments(orgId, plan.remove.map((r) => r.id));
    out.removed = plan.remove.length;
  }
  for (const row of plan.write) {
    try {
      const doc = await prisma.loadDocument.findFirst({ where: { id: row.desk_document_id, workspaceId }, select: { storageKey: true } });
      const bytes = doc ? await readFile(doc.storageKey) : null;
      if (!bytes) {
        out.failed += 1;
        continue;
      }
      await transport.uploadDeskFile(row.path, bytes, row.mime);
      await transport.upsertLoadDocument(row);
      out.sent += 1;
    } catch (e) {
      out.failed += 1;
      // No answer from the link: nothing else will go either, the next run takes the rest.
      if (e instanceof BridgeTransportError && e.code === "unreachable") break;
    }
  }
  return out;
}
