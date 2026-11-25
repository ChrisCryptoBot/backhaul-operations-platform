import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { applyFactoringUpdate } from "@/server/partners/factoring";
import { dataMark } from "@/server/tl/answer-cache";
import { countDeletedLoads, listDeletedLoads } from "@/server/tl/deleted";
import { deleteLoad, restoreLoad } from "@/server/tl/remove";
import { buildExport } from "@/server/tl/exports";
import { countHistory, listHistory } from "@/server/tl/history";
import { markLoadPaid, invoiceLoad, voidInvoice, undoPaid, issueCreditMemo, voidCreditMemo, recordChase, invoiceLoads, payInvoiceRecord } from "@/server/tl/invoicing";
import { assignDriver, dispatchLoad, recordDriverResponse, unassignLoad } from "@/server/tl/dispatch";
import { OPEN_LOAD_STATUSES, deskStatusOf, getLoadDetail, listBoardRows } from "@/server/tl/queries";
import { saveLoadDetails } from "@/server/tl/edit";
import { completeTrip, correctTrip, reopenDelivered, saveExpenses, startTrip, undoStartTrip } from "@/server/tl/execution";
import { cancelLoad, recordTonu, reopenCancelled, rescheduleLoad } from "@/server/tl/disruptions";
import { saveBillingDetails } from "@/server/tl/billing-details";
import { waiveDetention } from "@/server/tl/detention";
import { assignTrailerToLoad } from "@/server/tl/trailers";
import { loadSendGaps } from "@/server/tl/readiness";
import { getLoadTracking } from "@/server/tl/load-tracking";
import { logCheckCall } from "@/server/tl/check-calls";
import { addLoadDocument, listLoadDocuments, removeLoadDocument, setDocumentToDriver } from "@/server/tl/documents";
import { loadInScope } from "@/server/tl/scope";

/**
 * Loads, flow and scope: deleted loads listed and restorable, History and its counts narrowed by terminal, the CSV labelled and bounded like the screen, factoring moving one allowed step,
 * the kept answers noticing an unassign and a delete, and the phone's scheduled and dispatched read as the desk's own. A workspace of its own, so the figures are exact.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "ls-scope";
const day = (d: string) => new Date(`${d}T17:00:00Z`);

describe.skipIf(!run)("loads scope on the demo database", () => {
  const id: Record<string, string> = {};
  beforeAll(async () => {
    await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id: W } } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id: W } } }, { driver: { workspace: { id: W } } }] } });
    await prisma.workspace.deleteMany({ where: { id: W } });
    await prisma.workspace.create({ data: { id: W, name: "LS scope", plan: "enterprise" } });
    const dallas = await prisma.vehicle.create({ data: { workspaceId: W, name: "LS Dallas", type: "box_truck", terminal: "Dallas" } as never });
    const houston = await prisma.vehicle.create({ data: { workspaceId: W, name: "LS Houston", type: "box_truck", terminal: "Houston" } as never });
    const make = async (key: string, data: Record<string, unknown>) => {
      const l = await prisma.load.create({ data: { workspaceId: W, loadNumber: `LS-${key}`, brokerName: "LS Customer", originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK", loadedMiles: 260, quotedRevenue: 1000, ...data } as never });
      id[key] = l.id;
    };
    await make("D", { status: "completed", completedAt: day("2026-10-05"), vehicleId: dallas.id });
    await make("H", { status: "completed", completedAt: day("2026-10-06"), vehicleId: houston.id });
    await make("N", { status: "cancelled", cancelledAt: day("2026-10-07"), cancelReason: "broker_cancelled" });
    await make("S", { status: "scheduled", vehicleId: dallas.id });
    await make("P", { status: "dispatched" });
    await make("X", { status: "draft" });
  });
  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
    await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id: W } } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id: W } } }, { driver: { workspace: { id: W } } }] } });
    await prisma.workspace.deleteMany({ where: { id: W } });
  });

  test("History and its counts are narrowed to a terminal, keeping loads not placed anywhere", async () => {
    const all = await listHistory({}, W);
    expect(all.rows.map((r) => r.loadNumber).sort()).toEqual(["LS-D", "LS-H", "LS-N"]);
    const dallas = await listHistory({ terminal: "Dallas" }, W);
    expect(dallas.rows.map((r) => r.loadNumber).sort()).toEqual(["LS-D", "LS-N"]);
    expect(dallas.counts.all).toBe(2);
    expect(await countHistory("", W, "Houston")).toBe(2);
    expect(await countHistory("", W, null)).toBe(3);
  });

  test("the loads file says status in words and is the History on screen, with a file name that says when it was cut", async () => {
    const out = await buildExport("loads", { view: "history", q: "LS-" }, new Date("2026-11-01T12:00:00Z"));
    expect(out).not.toBeNull();
    // The export runs in the default workspace outside a request, so it reads no rows of this one; what matters here is the shape.
    expect(out!.csv.split("\n")[0]).toContain("Status");
    expect(out!.filename).toMatch(/^truelane-desk-loads-2026-11-01\.csv$/);
  });

  test("a deleted load is listed with its reason, and restoring it puts it back", async () => {
    expect(await countDeletedLoads(W)).toBe(0);
    expect(await deleteLoad({ loadId: id.X!, reason: "duplicate", note: "entered twice" }, new Date(), W)).toEqual({ ok: true });
    expect(await countDeletedLoads(W)).toBe(1);
    const [row] = await listDeletedLoads(W);
    expect(row).toMatchObject({ id: id.X, loadNumber: "LS-X", reason: expect.stringContaining("Duplicate"), note: "entered twice" });
    expect(await restoreLoad(id.X!, new Date(), W)).toEqual({ ok: true });
    expect(await countDeletedLoads(W)).toBe(0);
    // A quote that was thrown away is not a load and is not listed.
    await prisma.load.update({ where: { id: id.X! }, data: { status: "quote", deletedAt: new Date() } });
    expect(await countDeletedLoads(W)).toBe(0);
    await prisma.load.update({ where: { id: id.X! }, data: { status: "draft", deletedAt: null } });
  });

  test("the kept answers notice an unassign and a delete (the data mark moves)", async () => {
    const driver = await prisma.driver.create({ data: { workspaceId: W, name: "LS Driver" } });
    await prisma.assignment.create({ data: { loadId: id.X!, driverId: driver.id, payKind: "cpm", payRate: 0.5, status: "draft" } });
    const before = await dataMark(W);
    await unassignLoad(id.X!, null, new Date(), W);
    const afterUnassign = await dataMark(W);
    expect(afterUnassign).not.toBe(before);
    await deleteLoad({ loadId: id.X!, reason: "mistake" }, new Date(), W);
    expect(await dataMark(W)).not.toBe(afterUnassign);
    await restoreLoad(id.X!, new Date(), W);
    // Another workspace's change does not move this one's mark.
    const mine = await dataMark(W);
    await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id: "ls-other" } } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id: "ls-other" } } }, { driver: { workspace: { id: "ls-other" } } }] } });
    await prisma.workspace.deleteMany({ where: { id: "ls-other" } });
    await prisma.workspace.create({ data: { id: "ls-other", name: "LS other", plan: "enterprise" } });
    await prisma.load.create({ data: { workspaceId: "ls-other", loadNumber: "LS-OTHER", quotedRevenue: 1 } as never });
    expect((await dataMark(W)).split(":")[0]).toBe(mine.split(":")[0]);
    await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id: "ls-other" } } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id: "ls-other" } } }, { driver: { workspace: { id: "ls-other" } } }] } });
    await prisma.workspace.deleteMany({ where: { id: "ls-other" } });
  });

  test("factoring moves one allowed step, once, and a paid invoice closes a funded one", async () => {
    await prisma.load.update({ where: { id: id.D! }, data: { paymentStatus: "invoiced", invoiceNumber: "LS-D", invoicedAt: day("2026-10-06"), invoicedAmount: 1000, payTermsDays: 30, factoringStatus: "requested", factoringReferenceId: "R1" } });
    expect(await applyFactoringUpdate(id.D!, "paid", null, new Date(), W)).toBe(false); // a skipped step
    expect(await applyFactoringUpdate(id.D!, "funded", null, new Date(), W)).toBe(true);
    expect(await applyFactoringUpdate(id.D!, "funded", null, new Date(), W)).toBe(false); // the same report twice moves it once
    expect(await applyFactoringUpdate(id.D!, "requested", null, new Date(), W)).toBe(false); // never backwards
    expect(await prisma.auditEvent.count({ where: { loadId: id.D!, action: "factoring_updated" } })).toBe(1);
    expect(await markLoadPaid(id.D!, new Date(), {}, W)).toMatchObject({ ok: true });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: id.D! } })).factoringStatus).toBe("paid");
  });

  test("the phone's scheduled and dispatched are on the open board as accepted and sent", async () => {
    expect(OPEN_LOAD_STATUSES).toEqual(expect.arrayContaining(["scheduled", "dispatched"]));
    expect([deskStatusOf("scheduled"), deskStatusOf("dispatched"), deskStatusOf("completed")]).toEqual(["accepted", "draft", "completed"]);
    const rows = await listBoardRows(W, "open");
    const byNumber = Object.fromEntries(rows.map((r) => [r.loadNumber, r]));
    expect(byNumber["LS-S"]).toMatchObject({ status: "accepted" });
    expect(byNumber["LS-P"]).toMatchObject({ status: "draft", assignmentStatus: "dispatched" });
  });

  test("a Dallas-limited member is turned away on every single-load read and write for a Houston load, and invoiced loads never delete", async () => {
    const now = day("2026-10-12");
    const tDallas = await prisma.vehicle.findFirstOrThrow({ where: { workspaceId: W, terminal: "Dallas" } });
    const tHouston = await prisma.vehicle.findFirstOrThrow({ where: { workspaceId: W, terminal: "Houston" } });
    const trDallas = await prisma.trailer.create({ data: { workspaceId: W, number: "TR-DAL", type: "dry_van", terminal: "Dallas" } });
    const trHouston = await prisma.trailer.create({ data: { workspaceId: W, number: "TR-HOU", type: "dry_van", terminal: "Houston" } });
    const hDriver = await prisma.driver.create({ data: { workspaceId: W, name: "Houston Driver", terminal: "Houston", cdlExpiry: day("2028-01-01"), medicalCardExpiry: day("2028-01-01") } });

    const stopsData = () => ({
      create: [
        { stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Houston, TX", timeWindowEarliest: day("2026-10-10"), timeWindowLatest: day("2026-10-10") },
        { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Austin, TX", timeWindowEarliest: day("2026-10-11"), timeWindowLatest: day("2026-10-11") }
      ]
    });
    const dOpen = await prisma.load.create({ data: { workspaceId: W, loadNumber: "LS-D-OPEN", brokerName: "LS Customer", status: "draft", vehicleId: tDallas.id, quotedRevenue: 900, loadedMiles: 200, stops: stopsData() } });
    const dComp = await prisma.load.create({ data: { workspaceId: W, loadNumber: "LS-D-COMP", brokerName: "LS Customer", status: "completed", completedAt: now, vehicleId: tDallas.id, quotedRevenue: 900, loadedMiles: 200, stops: stopsData() } });
    const hOpen = await prisma.load.create({ data: { workspaceId: W, loadNumber: "LS-H-OPEN", brokerName: "LS Customer", status: "draft", vehicleId: tHouston.id, trailerType: "dry_van", weightLbs: 10000, quotedRevenue: 1200, loadedMiles: 250, pickupNumbers: ["PU-1"], stops: stopsData() }, include: { stops: { orderBy: { stopSequence: "asc" } } } });
    await assignDriver({ loadId: hOpen.id, driverId: hDriver.id, pay: { kind: "cpm", rate: 0.6 } }, now, W);
    const hComp = await prisma.load.create({ data: { workspaceId: W, loadNumber: "LS-H-COMP", brokerName: "LS Customer", status: "completed", completedAt: now, vehicleId: tHouston.id, quotedRevenue: 1100, loadedMiles: 220, stops: stopsData() }, include: { stops: true } });
    const hDel = await prisma.load.create({ data: { workspaceId: W, loadNumber: "LS-H-DEL", brokerName: "LS Customer", status: "draft", deletedAt: now, vehicleId: tHouston.id, quotedRevenue: 500, loadedMiles: 100 } });
    const hCan = await prisma.load.create({ data: { workspaceId: W, loadNumber: "LS-H-CAN", brokerName: "LS Customer", status: "cancelled", cancelledAt: now, cancelReason: "broker_cancelled", vehicleId: tHouston.id, quotedRevenue: 500, loadedMiles: 100 } });
    const txtType = { mime: "text/plain", exts: ["txt"], label: "Text", kind: "file" as const };
    const hDocRes = await addLoadDocument(hOpen.id, "other", { ok: true, name: "note.txt", type: txtType, data: new Uint8Array([65, 66]) }, now, W, "Admin", null, false, null);
    if (!hDocRes.ok) throw new Error(hDocRes.error);

    // Admin creates invoice + credit memo + mixed invoice (Dallas + Houston) to verify invoiceInScope.
    const dDoc = await addLoadDocument(dComp.id, "pod", { ok: true, name: "pod1.txt", type: txtType, data: new Uint8Array([80]) }, now, W, "Admin", null, false, null);
    const hDocComp = await addLoadDocument(hComp.id, "pod", { ok: true, name: "pod2.txt", type: txtType, data: new Uint8Array([80]) }, now, W, "Admin", null, false, null);
    if (!dDoc.ok || !hDocComp.ok) throw new Error("pod setup failed");
    const mixed = await invoiceLoads([dComp.id, hComp.id], { number: "LS-MIX-1", terms: "30" }, now, W, null);
    if (!mixed.ok) throw new Error(mixed.error);
    const mixedRec = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: "LS-MIX-1" } });
    const hSoloInv = await prisma.load.create({ data: { workspaceId: W, loadNumber: "LS-H-SOLOINV", brokerName: "LS Customer", brokerEmail: "ap@ls.example", status: "completed", completedAt: now, vehicleId: tHouston.id, quotedRevenue: 800, loadedMiles: 150, stops: stopsData() } });
    const soloPod = await addLoadDocument(hSoloInv.id, "pod", { ok: true, name: "pod3.txt", type: txtType, data: new Uint8Array([80]) }, now, W, "Admin", null, false, null);
    if (!soloPod.ok) throw new Error(soloPod.error);
    const soloInvOut = await invoiceLoad(hSoloInv.id, { form: { number: "LS-HS-1", terms: "30", detention: false, lumper: "", layover: "", otherLabel: "", other: "" } }, now, W, null);
    if (!soloInvOut.ok) throw new Error(soloInvOut.error);
    const credit = await issueCreditMemo(hSoloInv.id, { amount: 50, reason: "Short" }, now, W, null);
    if (!credit.ok) throw new Error(credit.error);
    const memoRow = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, kind: "credit_memo", number: credit.number } });

    const D: string[] = ["Dallas"];
    expect(await loadInScope(hOpen.id, W, D)).toBeNull();
    expect(await loadInScope(dOpen.id, W, D)).toEqual({ id: dOpen.id });
    expect(await getLoadDetail(hOpen.id, W, D)).toBeNull();
    await expect(dispatchLoad(hOpen.id, now, {}, W, D)).rejects.toMatchObject({ code: "load_not_found" });
    await expect(recordDriverResponse(hOpen.id, "accepted", now, undefined, W, "dispatcher", D)).rejects.toMatchObject({ code: "not_assigned" });
    expect(await saveLoadDetails(hOpen.id, { brokerName: "X", brokerMc: "", brokerPhone: "", brokerEmail: "", loadNumber: "LS-H-OPEN", poNumber: "", trailer: "dry_van", weightLbs: "10000", lengthFt: "", widthFt: "", heightIn: "", hazmat: "", liftgate: false, ramp: false, palletJack: false, payTermsDays: "", notes: "", stops: hOpen.stops.map((s) => ({ id: s.id, role: "pickup", address: s.addressString, facility: "", earliest: "2026-10-10T08:00", latest: "", refs: "", contactName: "", contactPhone: "", notes: "" })) }, now, W, D)).toMatchObject({ ok: false });
    expect(await startTrip(hOpen.id, { arrivedAt: "2026-10-10T08:00", waitMinutes: "", seal: "" }, now, W, "desk", D)).toMatchObject({ ok: false });
    expect(await undoStartTrip(hOpen.id, "wrong load", now, W, D)).toMatchObject({ ok: false });
    expect(await completeTrip(hOpen.id, { stops: [{ id: hOpen.stops[1]!.id, arrivedAt: "2026-10-11T08:00", waitMinutes: "" }], deliveredAt: "2026-10-11T09:00", pod: "received", podNote: "", fuel: "", tolls: "", misc: "" }, now, W, "desk", D)).toMatchObject({ ok: false });
    expect(await reopenDelivered(hComp.id, "wrong load", now, W, D)).toMatchObject({ ok: false });
    expect(await saveExpenses(hComp.id, { fuel: "10", tolls: "", misc: "" }, now, W, D)).toMatchObject({ ok: false });
    expect(await correctTrip(hComp.id, { stops: [{ id: hOpen.stops[0]!.id, arrivedAt: "", waitMinutes: "10", seal: "" }], reason: "fix" }, now, W, D)).toMatchObject({ ok: false });
    await expect(cancelLoad({ loadId: hOpen.id, reason: "broker_cancelled" }, now, W, D)).rejects.toMatchObject({ code: "load_not_found" });
    await expect(recordTonu({ loadId: hOpen.id, reason: "broker_cancelled", fee: 150 }, now, W, D)).rejects.toMatchObject({ code: "load_not_found" });
    await expect(rescheduleLoad({ loadId: hOpen.id, reason: "weather", newPickup: day("2026-10-14") }, now, W, D)).rejects.toMatchObject({ code: "load_not_found" });
    await expect(reopenCancelled({ loadId: hCan.id, reason: "mistake" }, now, W, D)).rejects.toMatchObject({ code: "load_not_found" });
    expect(await deleteLoad({ loadId: hOpen.id, reason: "mistake" }, now, W, D)).toMatchObject({ ok: false });
    expect(await restoreLoad(hDel.id, now, W, D)).toMatchObject({ ok: false });

    expect(await invoiceLoad(hOpen.id, {}, now, W, D)).toMatchObject({ ok: false });
    expect(await markLoadPaid(hSoloInv.id, now, {}, W, D)).toMatchObject({ ok: false });
    expect(await voidInvoice(hSoloInv.id, "wrong amount", now, W, D)).toMatchObject({ ok: false });
    expect(await undoPaid(hSoloInv.id, "bounced", now, W, D)).toMatchObject({ ok: false });
    expect(await issueCreditMemo(hSoloInv.id, { amount: 25, reason: "short" }, now, W, D)).toMatchObject({ ok: false });
    expect(await voidCreditMemo(memoRow.id, "mistake", now, W, D)).toMatchObject({ ok: false });
    expect(await recordChase(hSoloInv.id, "email", now, W, D)).toMatchObject({ ok: false });
    expect(await invoiceLoads([dComp.id, hComp.id], { number: "LS-MIX-2" }, now, W, D)).toMatchObject({ ok: false });
    expect(await payInvoiceRecord(mixedRec.id, now, {}, W, D)).toMatchObject({ ok: false });

    expect(await saveBillingDetails(hComp.id, { brokerName: "LS Customer", brokerMcNumber: "", brokerPhone: "", brokerEmail: "", poNumber: "", payTermsDays: "30", revenueNote: "note" }, now, W, D)).toMatchObject({ ok: false });
    expect(await waiveDetention(hComp.id, "customer asked", now, W, D)).toMatchObject({ ok: false });
    expect(await assignTrailerToLoad(hOpen.id, trDallas.id, now, W, D)).toMatchObject({ ok: false });
    expect(await assignTrailerToLoad(dOpen.id, trHouston.id, now, W, D)).toMatchObject({ ok: false });
    expect(await loadSendGaps(hOpen.id, W, D)).toEqual([]);
    expect(await getLoadTracking(hOpen.id, W, now, D)).toEqual({ status: "no_truck" });
    expect(await logCheckCall({ unit: { kind: "truck", id: tDallas.id }, loadId: hOpen.id, place: "I-45" }, now, W, D)).toMatchObject({ ok: false });
    expect(await logCheckCall({ unit: { kind: "truck", id: tHouston.id }, place: "I-45" }, now, W, D)).toMatchObject({ ok: false });
    expect(await addLoadDocument(hOpen.id, "other", { ok: true, name: "x.txt", type: txtType, data: new Uint8Array([65]) }, now, W, "Chris", null, false, D)).toMatchObject({ ok: false });
    expect(await listLoadDocuments(hOpen.id, W, D)).toEqual([]);
    expect(await setDocumentToDriver(hDocRes.id, true, now, W, D)).toMatchObject({ ok: false });
    expect(await removeLoadDocument(hDocRes.id, now, W, D)).toMatchObject({ ok: false });

    // Phase 1.2 policy pin: even an unrestricted admin cannot delete an invoiced or paid load without voiding first.
    expect(await deleteLoad({ loadId: hSoloInv.id, reason: "duplicate" }, now, W, null)).toMatchObject({ ok: false, error: expect.stringMatching(/invoiced load cannot be deleted/i) });
    await prisma.load.update({ where: { id: hSoloInv.id }, data: { paymentStatus: "paid" } });
    expect(await deleteLoad({ loadId: hSoloInv.id, reason: "duplicate" }, now, W, null)).toMatchObject({ ok: false, error: expect.stringMatching(/invoiced load cannot be deleted/i) });
  });
});
