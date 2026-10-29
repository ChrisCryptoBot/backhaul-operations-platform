import { afterAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { BLANK_CUSTOMER, type CustomerValues } from "@/lib/customer";
import { getCustomerDetail, saveCustomer } from "@/server/tl/customers";
import { invoiceLoad } from "@/server/tl/invoicing";
import { getThresholds } from "@/server/tl/thresholds";

/**
 * Needs a seeded database (see tl-dispatch.integration.test.ts). Makes its own customers and loads (all named WC3) and removes them and their
 * audit entries afterwards.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";
const at = (local: string) => new Date(`${local}:00-05:00`);

describe.skipIf(!run)("customers as records, on the demo database", () => {
  const startedAt = new Date();
  const form = (over: Partial<CustomerValues> = {}): CustomerValues => ({ ...BLANK_CUSTOMER, name: "WC3 Acme Freight", kind: "broker", ...over });

  const mkLoad = (n: string, broker: string | null, over: Record<string, unknown> = {}) =>
    prisma.load.create({
      data: { workspaceId: WS, loadNumber: `WC3-${n}`, brokerName: broker, status: "completed", completedAt: at("2026-10-10T15:00"), quotedRevenue: 1000, loadedMiles: 200, originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK", scheduledDate: at("2026-10-10T08:00"), ...over }
    });
  const events = (action: string) => prisma.auditEvent.findMany({ where: { action, createdAt: { gte: startedAt } }, orderBy: { createdAt: "asc" } });

  afterAll(async () => {
    const mine = await prisma.load.findMany({ where: { workspaceId: WS, OR: [{ loadNumber: { startsWith: "WC3-" } }, { brokerName: { startsWith: "WC3", mode: "insensitive" } }] }, select: { id: true } });
    const ids = mine.map((l) => l.id);
    await prisma.auditEvent.deleteMany({ where: { OR: [{ loadId: { in: ids } }, { createdAt: { gte: startedAt }, entity: "customer" }] } });
    await prisma.load.deleteMany({ where: { id: { in: ids } } });
    await prisma.customer.deleteMany({ where: { workspaceId: WS, name: { startsWith: "WC3", mode: "insensitive" } } });
  });

  test("a new record brings the loads that spell its name differently only in capitals to its spelling, and says so", async () => {
    const a = await mkLoad("CASE-A", "wc3 acme freight");
    const b = await mkLoad("CASE-B", "WC3 ACME FREIGHT");
    const other = await mkLoad("CASE-C", "WC3 Acme Freight Brokers"); // a different name that starts the same
    const out = await saveCustomer(form({ mcNumber: "MC 998877", contactEmail: "ap@wc3.example", defaultPayTermsDays: "21" }), null);
    if (!out.ok) throw new Error(JSON.stringify(out));
    const names = await prisma.load.findMany({ where: { id: { in: [a.id, b.id, other.id] } }, select: { id: true, brokerName: true } });
    expect(Object.fromEntries(names.map((l) => [l.id, l.brokerName]))).toEqual({ [a.id]: "WC3 Acme Freight", [b.id]: "WC3 Acme Freight", [other.id]: "WC3 Acme Freight Brokers" });
    const rec = await prisma.customer.findUniqueOrThrow({ where: { id: out.id } });
    expect(rec).toMatchObject({ kind: "broker", mcNumber: "998877", defaultPayTermsDays: 21 });
    expect((await events("customer_added")).pop()!.summary).toContain("2 loads now spell it the same");
  });

  test("a name already on the desk, in any capitals, is refused, and a form that is wrong names the field", async () => {
    expect(await saveCustomer(form({ name: "wc3 ACME freight" }), null)).toMatchObject({ ok: false, errors: { name: expect.stringContaining("already on the desk") } });
    expect(await saveCustomer(form({ name: "WC3 Bad", mcNumber: "12" }), null)).toMatchObject({ ok: false, errors: { mcNumber: expect.any(String) } });
    expect(await saveCustomer(form(), "no-such-id")).toMatchObject({ ok: false });
  });

  test("changing a record is audited with what moved; saving it unchanged is not a change; a rename takes its loads with it", async () => {
    const rec = await prisma.customer.findFirstOrThrow({ where: { workspaceId: WS, name: "WC3 Acme Freight" } });
    const l = await mkLoad("REN-1", "WC3 Acme Freight");
    expect(await saveCustomer(form({ mcNumber: "998877", contactEmail: "ap@wc3.example", defaultPayTermsDays: "21" }), rec.id)).toEqual({ ok: true, id: rec.id, changed: false });

    expect(await saveCustomer(form({ mcNumber: "998877", contactEmail: "ap@wc3.example", defaultPayTermsDays: "45", notes: "Slow in December" }), rec.id)).toEqual({ ok: true, id: rec.id, changed: true });
    const ev = (await events("customer_changed")).pop()!;
    expect(ev.after).toEqual({ "Default terms (days)": "45", Notes: "Slow in December" });
    expect(ev.before).toEqual({ "Default terms (days)": "21", Notes: null });

    expect(await saveCustomer(form({ name: "WC3 Acme Freight Group", mcNumber: "998877", contactEmail: "ap@wc3.example", defaultPayTermsDays: "45", notes: "Slow in December" }), rec.id)).toMatchObject({ ok: true, changed: true });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: l.id } })).brokerName).toBe("WC3 Acme Freight Group");
    expect((await events("customer_changed")).pop()!.summary).toMatch(/loads? renamed with it/);
  });

  test("an invoice to a customer takes the customer's usual terms when the load names none, and the desk's when there is no record", async () => {
    await saveCustomer(form({ name: "WC3 Terms Co", defaultPayTermsDays: "21" }), null);
    const withTerms = await mkLoad("TERMS-1", "WC3 Terms Co", { payTermsDays: null });
    const none = await mkLoad("TERMS-2", "WC3 No Record Co", { payTermsDays: null });
    const own = await mkLoad("TERMS-3", "WC3 Terms Co", { payTermsDays: 60 });
    const f = (n: string) => ({ number: n, terms: "", detention: false, lumper: "", layover: "", otherLabel: "", other: "" });
    for (const [l, n] of [[withTerms, "WC3-INV-T1"], [none, "WC3-INV-T2"], [own, "WC3-INV-T3"]] as const) expect(await invoiceLoad(l.id, { form: f(n) })).toMatchObject({ ok: true });
    const terms = async (id: string) => (await prisma.load.findUniqueOrThrow({ where: { id } })).payTermsDays;
    expect(await terms(withTerms.id)).toBe(21);
    expect(await terms(none.id)).toBe((await getThresholds()).defaultPayTermsDays);
    expect(await terms(own.id)).toBe(60); // the load's own terms still win
  });

  test("a customer's page: scored from its invoiced loads, with or without a record, and nothing for an id that is not there", async () => {
    await prisma.load.deleteMany({ where: { workspaceId: WS, loadNumber: { startsWith: "WC3-SC" } } });
    await mkLoad("SC-1", "WC3 Scored Co", { paymentStatus: "paid", invoicedAt: at("2026-09-01T10:00"), paidAt: at("2026-09-20T10:00"), payTermsDays: 30, invoicedAmount: 1000, paidAmount: 940 }); // inside terms, $60 short
    await mkLoad("SC-2", "WC3 Scored Co", { paymentStatus: "paid", invoicedAt: at("2026-08-01T10:00"), paidAt: at("2026-09-15T10:00"), payTermsDays: 30, invoicedAmount: 1000, paidAmount: 1000 }); // 45 days: late
    await mkLoad("SC-3", "WC3 Scored Co", { paymentStatus: "invoiced", invoicedAt: at("2026-09-01T10:00"), payTermsDays: 30, invoicedAmount: 700 });
    const now = new Date("2026-10-30T15:00:00Z");

    const bare = (await getCustomerDetail({ name: "wc3 scored co" }, now))!; // a name from the loads, no record yet
    expect(bare.record).toBeNull();
    expect(bare.loadCount).toBe(3);
    expect(bare.scorecard).toMatchObject({ paid: 2, paidWithinTerms: 1, shortPaid: { loads: 1, dollars: 60 }, outstanding: { count: 1, total: 700, overdue: 1 } });
    expect(bare.scorecard.outstanding.oldestDaysOverdue).toBe(29); // due 1 Oct, seen on 30 Oct
    expect(bare.recent).toHaveLength(3);

    const made = await saveCustomer(form({ name: "WC3 Scored Co", kind: "shipper" }), null);
    if (!made.ok) throw new Error("save");
    const rec = (await getCustomerDetail({ id: made.id }, now))!;
    expect(rec.record).toMatchObject({ kind: "shipper" });
    expect(rec.scorecard.paid).toBe(2);
    expect(await getCustomerDetail({ id: "no-such-id" }, now)).toBeNull();
    expect(await getCustomerDetail({}, now)).toBeNull();
  });
});
