import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { syncDriverReceipts } from "@/server/bridge/receipts";
import { memoryTransport } from "@/server/bridge/transport";
import { decideReceipt, receiptQueue } from "@/server/tl/receipts";
import { finalizeSettlement, getSettlement, listSettlements, markSettlementPaid, startSettlement, voidSettlement } from "@/server/tl/settlement";
import { removeFiles, readFile } from "@/server/tl/message-files";

/**
 * Sync plan Step 5b on the demo database, with the in-memory bridge standing in for Supabase (no network):
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/driver-receipts.integration.test.ts
 * It makes its own driver and load, and takes them away again.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const ORG = "org_test_receipts";
const PHONE = "user_test_receipts";
const DAY = 86_400_000;
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 1, 2, 3, 0xff, 0xd9]);

describe.skipIf(!run)("driver receipts over the bridge", () => {
  const ws = currentWorkspaceId();
  const now = new Date();
  let down = false;
  const t = memoryTransport({ down: () => down });
  const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  let savedOrg: string | null = null;
  let driverId = "";
  let loadId = "";
  let first = "";

  const phoneSends = (n: string, cents: number, o: { photo?: boolean; path?: string; sub?: string; org?: string } = {}) => {
    const path = o.path ?? `org/${ORG}/driver/${PHONE}/rcpt-${n}.jpg`;
    if (o.photo !== false) t.files.set(path, JPEG);
    t.receipts.push({ id: `bridge-${n}-${now.getTime()}`, org_id: o.org ?? ORG, driver_sub: o.sub ?? PHONE, amount_cents: cents, kind: "tolls", spent_on: ymd(now.getTime() - DAY), note: "PA Turnpike", source_load_id: loadId, path, state: "submitted", reason: null, statement_number: null, taken_at: null, created_at: new Date().toISOString() });
    return `bridge-${n}-${now.getTime()}`;
  };
  const sync = () => syncDriverReceipts(t, { workspaceId: ws });
  const told = (id: string) => t.receipts.find((r) => r.id === id)!;
  const mine = async () => (await receiptQueue(ws, null)).waiting.filter((r) => r.driverId === driverId);
  const start = async () => {
    const made = await startSettlement({ driverId, start: ymd(now.getTime() - 5 * DAY), end: ymd(now.getTime()) }, new Date(), ws);
    if (!made.ok) throw new Error(made.error);
    return made.id;
  };

  beforeAll(async () => {
    savedOrg = (await prisma.workspace.findUniqueOrThrow({ where: { id: ws }, select: { bridgeOrgId: true } })).bridgeOrgId;
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: ORG } });
    driverId = (await prisma.driver.create({ data: { workspaceId: ws, name: "Receipt Test", phoneUserId: PHONE, payrollWorkerType: "contractor" } })).id;
    const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = await prisma.load.findFirstOrThrow({ where: { workspaceId: ws, loadNumber: "DM-40006" } });
    void _i; void _c; void _u;
    loadId = (await prisma.load.create({ data: { ...(rest as object), loadNumber: "RCPT-1", status: "completed", completedAt: new Date(now.getTime() - 2 * DAY), loadedMiles: 400, assignment: { create: { driverId, payKind: "cpm", payRate: 0.5, status: "completed" } } } as never })).id;
  });

  afterAll(async () => {
    await removeFiles((await prisma.driverReceipt.findMany({ where: { driverId } })).flatMap((r) => (r.storageKey ? [r.storageKey] : [])));
    await prisma.driverReceipt.deleteMany({ where: { driverId } });
    const ids = (await prisma.settlement.findMany({ where: { driverId }, select: { id: true } })).map((s) => s.id);
    await prisma.settlementLoad.deleteMany({ where: { settlementId: { in: ids } } });
    await prisma.settlement.deleteMany({ where: { driverId } });
    await prisma.assignment.deleteMany({ where: { driverId } });
    await prisma.load.deleteMany({ where: { id: loadId } });
    await prisma.auditEvent.deleteMany({ where: { workspaceId: ws, createdAt: { gte: now }, OR: [{ loadId }, { summary: { contains: "Receipt Test" } }] } });
    await prisma.driver.delete({ where: { id: driverId } });
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: savedOrg } });
  });

  test("taken once with its photo, which then leaves the bridge; another fleet's and an unknown phone's are left", async () => {
    first = phoneSends("a", 4250);
    phoneSends("other", 100, { org: "another_org" });
    phoneSends("stranger", 100, { sub: "user_nobody" });
    expect(await sync()).toMatchObject({ taken: 1, ignored: 1 });
    expect(await sync()).toMatchObject({ taken: 0 });
    const [r] = await mine();
    expect(r).toMatchObject({ kind: "tolls", amount: 42.5, note: "PA Turnpike", hasPhoto: true, load: { id: loadId, number: "RCPT-1" } });
    expect(t.files.has(told(first).path)).toBe(false);
    const key = (await prisma.driverReceipt.findUniqueOrThrow({ where: { bridgeId: first } })).storageKey!;
    expect((await readFile(key))!.length).toBeGreaterThan(0);
  });

  test("no answer from the link waits; a photo that is gone, or outside the folder, is named and the receipt still stands", async () => {
    const gone = phoneSends("gone", 900, { photo: false });
    down = true;
    await expect(sync()).rejects.toMatchObject({ code: "unreachable" });
    down = false;
    await sync();
    expect((await prisma.driverReceipt.findUniqueOrThrow({ where: { bridgeId: gone } })).photoMissing).toContain("no longer");
    const outside = phoneSends("outside", 800, { path: `org/${ORG}/driver/someone_else/x.jpg` });
    await sync();
    expect((await prisma.driverReceipt.findUniqueOrThrow({ where: { bridgeId: outside } })).photoMissing).toContain("outside");
    expect(t.files.has(`org/${ORG}/driver/someone_else/x.jpg`)).toBe(true);
    for (const r of await mine()) if (r.amount !== 42.5) expect(await decideReceipt(r.id, "declined", "No photo", new Date(), ws, null)).toEqual({ ok: true });
    await sync();
    expect(told(gone)).toMatchObject({ state: "declined", reason: "No photo" });
  });

  test("declining needs a reason; a decision can be put back; another workspace cannot see it", async () => {
    const [r] = await mine();
    expect(await decideReceipt(r!.id, "declined", " ", new Date(), ws, null)).toMatchObject({ ok: false });
    expect(await decideReceipt(r!.id, "approved", null, new Date(), "another-workspace", null)).toMatchObject({ ok: false });
    expect(await decideReceipt(r!.id, "approved", null, new Date(), ws, null)).toEqual({ ok: true });
    expect(await decideReceipt(r!.id, "declined", "changed my mind", new Date(), ws, null)).toMatchObject({ ok: false });
    expect(await decideReceipt(r!.id, "submitted", null, new Date(), ws, null)).toEqual({ ok: true });
    expect(await decideReceipt(r!.id, "approved", null, new Date(), ws, null)).toEqual({ ok: true });
    await sync();
    expect(told(first).state).toBe("approved");
  });

  test("approved, it is on the next draft by itself, finalizes as its own line, and voiding frees it", async () => {
    const id = await start();
    const draft = (await getSettlement(id, ws))!;
    expect(draft.reimbursements).toHaveLength(1);
    expect(draft.statement.total).toBe(242.5);
    expect((await listSettlements(ws, { status: "draft", driverId }))[0]!.total).toBe(242.5);
    expect(await finalizeSettlement(id, { hours: {}, adjustments: [] }, new Date(), ws, 242.5)).toMatchObject({ ok: true });
    expect((await prisma.settlementLine.findMany({ where: { settlementId: id }, orderBy: { sort: "asc" } })).map((l) => [l.kind, Number(l.amount)])).toEqual([["load", 200], ["reimbursement", 42.5]]);
    expect((await getSettlement(id, ws))!.statement.total).toBe(242.5);
    await sync();
    expect(told(first)).toMatchObject({ state: "settled", statement_number: draft.number });
    const r = (await receiptQueue(ws, null)).decided.find((x) => x.driverId === driverId && x.state === "approved")!;
    expect(await decideReceipt(r.id, "submitted", null, new Date(), ws, null)).toMatchObject({ ok: false, error: expect.stringContaining(draft.number) });
    expect(await voidSettlement(id, "receipt test", new Date(), ws)).toMatchObject({ ok: true });
    await sync();
    expect(told(first)).toMatchObject({ state: "approved", statement_number: null });
  });

  test("put back after the draft was opened: the finalize is refused at the total that was seen; then paid on the next one, told paid", async () => {
    const id = await start();
    const r = (await receiptQueue(ws, null)).decided.find((x) => x.driverId === driverId && x.state === "approved")!;
    await decideReceipt(r.id, "submitted", null, new Date(), ws, null);
    expect(await finalizeSettlement(id, { hours: {}, adjustments: [] }, new Date(), ws, 242.5)).toMatchObject({ ok: false, error: expect.stringContaining("$200.00") });
    await decideReceipt(r.id, "approved", null, new Date(), ws, null);
    expect(await finalizeSettlement(id, { hours: {}, adjustments: [] }, new Date(), ws, 242.5)).toMatchObject({ ok: true });
    await markSettlementPaid(id, { paidOn: ymd(now.getTime()), method: "check" }, new Date(), ws);
    await sync();
    expect(told(first).state).toBe("paid");
    expect((await sync()).told).toBe(0);
  });
});
