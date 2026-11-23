import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { assignDriver, dispatchLoad, unassignLoad } from "@/server/tl/dispatch";
import { addLoadDocument, listLoadDocuments, removeLoadDocument, setDocumentToDriver } from "@/server/tl/documents";
import { sendMessage } from "@/server/tl/messages";
import { flushBridgeOutbox, purgeDriverMessages } from "@/server/bridge/service";
import { mirrorLoadDocuments } from "@/server/bridge/documents";
import { memoryTransport } from "@/server/bridge/transport";
import { removeFiles } from "@/server/tl/message-files";
import { checkAttachment } from "@/lib/attachments";

/**
 * Sync plan Step 4 on the demo database, with the in-memory bridge standing in for Supabase (no network):
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/load-documents.integration.test.ts
 * It makes its own load and driver, and takes them away again.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const ORG = "org_test_documents";
const PHONE = "user_test_documents";

describe.skipIf(!run)("load documents over the bridge", () => {
  const ws = currentWorkspaceId();
  const saved: Record<string, string | undefined> = {};
  let savedOrg: string | null = null;
  let loadId = "";
  let driverId = "";
  const t = memoryTransport();
  const mirror = () => mirrorLoadDocuments(t, { workspaceId: ws });
  const pdf = (name: string, text: string) => {
    const c = checkAttachment(name, "application/pdf", new TextEncoder().encode(`%PDF-1.4\n% ${text}\n%%EOF\n`));
    if (!c.ok) throw new Error(c.error);
    return c;
  };
  const names = () => t.documents.map((d) => d.name).sort();

  beforeAll(async () => {
    for (const k of ["BRIDGE_SUPABASE_URL", "BRIDGE_SUPABASE_SERVICE_KEY"]) saved[k] = process.env[k];
    process.env.BRIDGE_SUPABASE_URL = "https://bridge.test.invalid";
    process.env.BRIDGE_SUPABASE_SERVICE_KEY = "test-key-not-real";
    savedOrg = (await prisma.workspace.findUniqueOrThrow({ where: { id: ws }, select: { bridgeOrgId: true } })).bridgeOrgId;
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: ORG } });
    driverId = (await prisma.driver.create({ data: { workspaceId: ws, name: "Documents Test", phoneUserId: PHONE } })).id;
    const like = await prisma.load.findFirstOrThrow({ where: { workspaceId: ws, loadNumber: "DM-40006" } });
    const { id: _id, createdAt: _c, updatedAt: _u, loadNumber: _n, ...rest } = like;
    void _id; void _c; void _u; void _n;
    loadId = (await prisma.load.create({ data: { ...(rest as object), loadNumber: "DOC-TEST", status: "draft", stops: { create: [
      { stopSequence: 1, stopType: "pickup", addressString: "Dallas, TX" },
      { stopSequence: 2, stopType: "delivery", addressString: "Tulsa, OK" }
    ] } } as never })).id;
  });

  afterAll(async () => {
    const keys = [
      ...(await prisma.loadDocument.findMany({ where: { loadId }, select: { storageKey: true } })),
      ...(await prisma.messageAttachment.findMany({ where: { message: { thread: { driverId } } }, select: { storageKey: true } }))
    ].map((k) => k.storageKey);
    await removeFiles(keys);
    await prisma.bridgeOutbox.deleteMany({ where: { OR: [{ loadId }, { phoneUserId: PHONE }] } });
    await prisma.auditEvent.deleteMany({ where: { loadId } });
    await prisma.assignmentEvent.deleteMany({ where: { loadId } });
    await prisma.assignment.deleteMany({ where: { loadId } });
    await prisma.load.deleteMany({ where: { id: loadId } });
    await prisma.thread.deleteMany({ where: { driverId } });
    await prisma.driver.deleteMany({ where: { id: driverId } });
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: savedOrg } });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("nothing goes before the load is on the phone", async () => {
    expect(await addLoadDocument(loadId, "bol", pdf("bol.pdf", "bol"), new Date(), ws)).toMatchObject({ ok: true });
    await addLoadDocument(loadId, "rate_con", pdf("rc.pdf", "rate"), new Date(), ws);
    await addLoadDocument(loadId, "receipt", pdf("receipt.pdf", "money"), new Date(), ws);
    await addLoadDocument(loadId, "other", pdf("gate map.pdf", "map"), new Date(), ws);
    expect(await mirror()).toEqual({ sent: 0, removed: 0, failed: 0 });
  });

  test("sent with the load: the bill of lading only, bytes and all; a second run writes nothing", async () => {
    await assignDriver({ loadId, driverId, pay: { kind: "cpm", rate: 0.6 }, overrideReason: "documents test" });
    await dispatchLoad(loadId);
    await flushBridgeOutbox(t, { workspaceId: ws });
    expect(await mirror()).toEqual({ sent: 1, removed: 0, failed: 0 });
    expect(t.documents).toHaveLength(1);
    expect(t.documents[0]).toMatchObject({ org_id: ORG, driver_sub: PHONE, source_load_id: loadId, kind: "bol", name: "bol.pdf", mime: "application/pdf" });
    expect(new TextDecoder().decode(t.files.get(t.documents[0]!.path)!)).toContain("% bol");
    expect(await mirror()).toEqual({ sent: 0, removed: 0, failed: 0 });
  });

  test("other goes when ticked and comes back when unticked; nothing else can be ticked", async () => {
    const docs = await listLoadDocuments(loadId, ws);
    const by = (k: string) => docs.find((d) => d.kind === k)!;
    expect(await setDocumentToDriver(by("rate_con").id, true, new Date(), ws)).toMatchObject({ ok: false });
    expect(await setDocumentToDriver(by("receipt").id, true, new Date(), ws)).toMatchObject({ ok: false });
    expect(await setDocumentToDriver(by("other").id, true, new Date(), ws)).toMatchObject({ ok: true });
    await mirror();
    expect(names()).toEqual(["bol.pdf", "gate map.pdf"]);
    const path = t.documents.find((d) => d.kind === "other")!.path;
    await setDocumentToDriver(by("other").id, false, new Date(), ws);
    expect(await mirror()).toEqual({ sent: 0, removed: 1, failed: 0 });
    expect(t.files.has(path)).toBe(false);
    expect(await setDocumentToDriver(by("other").id, true, new Date(), "another-workspace")).toMatchObject({ ok: false });
  });

  test("the rate confirmation filed again as instructions is held back", async () => {
    await addLoadDocument(loadId, "instructions", pdf("sneaky.pdf", "rate"), new Date(), ws);
    expect(await mirror()).toEqual({ sent: 0, removed: 0, failed: 0 });
    expect(names()).toEqual(["bol.pdf"]);
  });

  test("a removed document, and a driver taken off the load, take the files off the phone", async () => {
    await addLoadDocument(loadId, "lumper", pdf("lumper.pdf", "lumper"), new Date(), ws);
    await mirror();
    expect(names()).toEqual(["bol.pdf", "lumper.pdf"]);
    const lumper = (await listLoadDocuments(loadId, ws)).find((d) => d.kind === "lumper")!;
    await removeLoadDocument(lumper.id, new Date(), ws);
    await mirror();
    expect(names()).toEqual(["bol.pdf"]);
    await unassignLoad(loadId, "documents test", undefined, undefined, undefined, "ASSIGNED_IN_ERROR");
    expect(await mirror()).toEqual({ sent: 0, removed: 1, failed: 0 });
    expect(t.documents).toHaveLength(0);
    expect([...t.files.keys()]).toEqual([]);
  });

  test("a link that does not answer loses nothing: the next run sends it", async () => {
    let down = false;
    const u = memoryTransport({ down: () => down });
    await assignDriver({ loadId, driverId, pay: { kind: "cpm", rate: 0.6 }, overrideReason: "documents test" });
    await dispatchLoad(loadId);
    await flushBridgeOutbox(u, { workspaceId: ws });
    down = true;
    await expect(mirrorLoadDocuments(u, { workspaceId: ws })).rejects.toMatchObject({ code: "unreachable" });
    down = false;
    expect(await mirrorLoadDocuments(u, { workspaceId: ws })).toMatchObject({ sent: 1 });
  });

  test("a file on a message goes with it, a rate confirmation does not, and both leave a day after it was read", async () => {
    const m = memoryTransport();
    const sent = await sendMessage({ driverId, body: "Gate map", allowed: null, files: [pdf("map.pdf", "map 2"), pdf("rc copy.pdf", "rate")] }, ws);
    expect(sent.ok).toBe(true);
    expect((await flushBridgeOutbox(m, { workspaceId: ws })).delivered).toBeGreaterThanOrEqual(1);
    const row = m.messages[0]!;
    expect(row.desk_file_count).toBe(2);
    expect(row.attachments).toHaveLength(1);
    expect(row.attachments[0]).toMatchObject({ name: "map.pdf", mime: "application/pdf" });
    expect(row.attachments[0]!.path.startsWith(`org/${ORG}/desk/${PHONE}/`)).toBe(true);
    expect(new TextDecoder().decode(m.files.get(row.attachments[0]!.path)!)).toContain("map 2");
    m.phoneReads(ORG, PHONE, new Date(Date.now() - 2 * 86_400_000));
    if (!row.delivered_at) m.messages[0]!.delivered_at = new Date(Date.now() - 2 * 86_400_000).toISOString();
    expect(await purgeDriverMessages(m, { workspaceId: ws })).toEqual({ removed: 1, files: 1 });
    expect(m.files.size).toBe(0);
  });
});
