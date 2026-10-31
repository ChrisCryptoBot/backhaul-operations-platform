import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { saveExpenses } from "@/server/tl/execution";
import { listHistory } from "@/server/tl/history";
import { invoiceLoad, markLoadPaid, undoPaid } from "@/server/tl/invoicing";
import { listBoardRows } from "@/server/tl/queries";

/**
 * Loads, one money contract: the board, History and its month totals agree on what a load earned, a TONU shows its fee and its money state, a part-paid invoice shows what is in and
 * what is to come, a write-off is kept on the load and removed by the undo, and layover pay entered with the expenses counts. A workspace of its own, so the totals are exact.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "lm-money";
const day = (d: string) => new Date(`${d}T17:00:00Z`);

describe.skipIf(!run)("loads money on the demo database", () => {
  const id: Record<string, string> = {};
  beforeAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: W } });
    await prisma.workspace.create({ data: { id: W, name: "LM money", plan: "enterprise" } });
    const make = async (key: string, data: Record<string, unknown>) => {
      const l = await prisma.load.create({ data: { workspaceId: W, loadNumber: `LM-${key}`, brokerName: "LM Broker", originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK", loadedMiles: 260, ...data } as never });
      id[key] = l.id;
    };
    // October: a normal delivery, a short-paid one with a surcharge, and a TONU. November: one more, so the months are two.
    await make("A", { status: "completed", completedAt: day("2026-10-05"), quotedRevenue: 1000 });
    await make("B", { status: "completed", completedAt: day("2026-10-06"), quotedRevenue: 1000, actualRevenue: 850, fuelSurcharge: 50 });
    await make("T", { status: "tonu", cancelledAt: day("2026-10-07"), quotedRevenue: 2000, tonuRevenue: 150, paymentStatus: "invoiced", invoiceNumber: "LM-T-INV", invoicedAt: day("2026-10-08"), invoicedAmount: 150, payTermsDays: 30 });
    await make("N", { status: "completed", completedAt: day("2026-11-02"), quotedRevenue: 500, layoverPay: 75 });
  });
  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
    await prisma.workspace.deleteMany({ where: { id: W } });
  });

  test("the board and History carry the same gross: paid linehaul else agreed, plus surcharge and layover; a TONU is its fee", async () => {
    const board = await listBoardRows(W, "all");
    const gross = (k: string) => board.find((r) => r.id === id[k])!.grossRevenue;
    expect(gross("A")).toBe(1000);
    expect(gross("B")).toBe(900);
    expect(gross("T")).toBe(150);
    expect(gross("N")).toBe(575);
    const hist = await listHistory({ sort: "pay" }, W);
    expect(hist.rows.map((r) => r.loadNumber)).toEqual(["LM-A", "LM-B", "LM-N", "LM-T"]);
    expect(hist.rows.map((r) => r.grossRevenue)).toEqual([1000, 900, 575, 150]);
  });

  test("month totals cover the whole month, not only the rows on the page", async () => {
    const small = await listHistory({ pageSize: 2 }, W);
    expect(small.rows).toHaveLength(2);
    expect(small.months["2026-10"]).toEqual({ loads: 3, earned: 1000 + 900 + 150 });
    expect(small.months["2026-11"]).toEqual({ loads: 1, earned: 575 });
  });

  test("an invoiced TONU is owed until it is paid", async () => {
    const owed = await listHistory({ filter: "owed" }, W);
    expect(owed.rows.map((r) => r.loadNumber)).toContain("LM-T");
    expect(owed.counts.owed).toBe(owed.rows.length);
    await markLoadPaid(id.T!, new Date(), {}, W);
    const after = await listHistory({ filter: "owed" }, W);
    expect(after.rows.map((r) => r.loadNumber)).not.toContain("LM-T");
  });

  test("a write-off is kept on the load with its reason, and taking the payment back clears it", async () => {
    await prisma.load.update({ where: { id: id.A! }, data: { paymentStatus: "invoiced", invoiceNumber: "LM-A-INV", invoicedAt: day("2026-10-06"), invoicedAmount: 1000, payTermsDays: 30 } });
    expect(await markLoadPaid(id.A!, new Date(), { amount: 940, shortAction: "writeoff", shortReason: "Customer deducted a lumper fee" }, W)).toMatchObject({ ok: true });
    const paid = await prisma.load.findUniqueOrThrow({ where: { id: id.A! } });
    expect(Number(paid.writeOffAmount)).toBe(60);
    expect(paid.writeOffReason).toBe("Customer deducted a lumper fee");
    expect(await undoPaid(id.A!, "Entered against the wrong invoice", new Date(), W)).toEqual({ ok: true });
    const back = await prisma.load.findUniqueOrThrow({ where: { id: id.A! } });
    expect(back.writeOffAmount).toBeNull();
    expect(back.writeOffReason).toBeNull();
  });

  test("the invoice bills the agreed rate even when the linehaul paid was less, so the difference shows as short", async () => {
    await prisma.load.update({ where: { id: id.B! }, data: { brokerEmail: "ap@lm.test" } as never });
    const inv = await invoiceLoad(id.B!, { form: { number: "LM-B-INV", terms: "30", detention: false, lumper: "", layover: "", otherLabel: "", other: "" } }, new Date(), W);
    expect(inv).toMatchObject({ ok: true });
    const billed = await prisma.load.findUniqueOrThrow({ where: { id: id.B! } });
    expect(Number(billed.invoicedAmount)).toBe(1050); // agreed 1000 + surcharge 50, not the 850 paid
  });

  test("layover pay entered with the expenses is kept, counts in the gross, and is audited", async () => {
    expect(await saveExpenses(id.N!, { fuel: "", tolls: "", misc: "", layover: "125" }, new Date(), W)).toMatchObject({ ok: true, changed: true });
    expect(Number((await prisma.load.findUniqueOrThrow({ where: { id: id.N! } })).layoverPay)).toBe(125);
    expect((await listBoardRows(W, "all")).find((r) => r.id === id.N)!.grossRevenue).toBe(625);
    expect(await prisma.auditEvent.count({ where: { loadId: id.N!, action: { not: "created" }, summary: { contains: "ayover" } } })).toBeGreaterThan(0);
    expect(await saveExpenses(id.N!, { fuel: "", tolls: "", misc: "", layover: "125" }, new Date(), W)).toMatchObject({ ok: true, changed: false });
  });
});
