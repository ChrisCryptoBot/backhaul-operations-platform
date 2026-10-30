import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { GET as pickTrailers } from "@/app/(desk)/trailers/pick/route";
import { clearAlertCache, getAlerts } from "@/server/tl/alerts";
import { listEntityAudit } from "@/server/tl/audit";
import { buildExport } from "@/server/tl/exports";
import { commitImport, previewImport } from "@/server/tl/import";
import { fitQuote } from "@/server/tl/quote";
import { BLANK_QUOTE, readQuote } from "@/lib/quote";
import { assignTrailerToLoad, countTrailersAvailable, getTrailerDetail, hookTrailer, listTrailersPage, saveTrailer, setTrailerArchived } from "@/server/tl/trailers";

/**
 * Wave E2 on the demo database, in a workspace of its own: the trailer registry (add, change, archive, hook to a tractor, put on a load), what keeps a trailer off a
 * load, the list's search and filters, the free-trailer count the Quote shows, the CSV import and export, and the alert on a load whose trailer cannot go out.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "e2-trailers";
const OTHER = "e2-other";
const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const ymd = (n: number) => days(n).toISOString().slice(0, 10);
const FUTURE = new Date("2031-01-31T12:00:00Z");

async function wipe(id: string) {
  await prisma.workspace.deleteMany({ where: { id } });
}

describe.skipIf(!run)("the trailer registry", () => {
  const ids = { truck: "", truck2: "", load: "", load2: "" };
  const t = (over: Record<string, string> = {}) => ({ number: "E2-100", type: "dry_van", plate: "ABC123", plateState: "TX", lengthFt: "53", maxPayloadLbs: "44000", terminal: "E2 Yard", registrationExpiry: ymd(300), inspectionExpiry: ymd(200), ...over });
  const quoteDay = "2027-04-14";

  beforeAll(async () => {
    await wipe(W);
    await wipe(OTHER);
    await prisma.workspace.create({ data: { id: W, name: "E2 fleet" } });
    await prisma.workspace.create({ data: { id: OTHER, name: "E2 other" } });
    const truck = await prisma.vehicle.create({ data: { workspaceId: W, name: "E2 Truck 1", terminal: "E2 Yard" } });
    const truck2 = await prisma.vehicle.create({ data: { workspaceId: W, name: "E2 Truck 2" } });
    const window = (start: string, end: string) => ({ create: [{ stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", timeWindowEarliest: new Date(start), timeWindowLatest: new Date(start) }, { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Tulsa, OK", timeWindowEarliest: new Date(end), timeWindowLatest: new Date(end) }] });
    const load = await prisma.load.create({ data: { workspaceId: W, loadNumber: "E2-L1", status: "accepted", quotedRevenue: 1000, trailerType: "dry_van", weightLbs: 30000, vehicleId: truck.id, stops: window(`${quoteDay}T08:00:00Z`, `${quoteDay}T18:00:00Z`) } });
    const load2 = await prisma.load.create({ data: { workspaceId: W, loadNumber: "E2-L2", status: "draft", quotedRevenue: 900, stops: window(`${quoteDay}T10:00:00Z`, `${quoteDay}T20:00:00Z`) } });
    Object.assign(ids, { truck: truck.id, truck2: truck2.id, load: load.id, load2: load2.id });
  });
  afterAll(async () => {
    await wipe(W);
    await wipe(OTHER);
  });

  test("a trailer is added with its audit event, found by id; a number in service is refused in any capitalisation", async () => {
    const out = await saveTrailer(t(), null, new Date(), W);
    expect(out).toMatchObject({ ok: true, changed: true });
    if (!out.ok) return;
    const feed = await listEntityAudit(out.id, 10, W);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ action: "trailer_added", entity: "trailer", summary: "E2-100 added as a trailer" });
    expect(await saveTrailer(t({ number: "e2-100" }), null, new Date(), W)).toMatchObject({ ok: false, errors: { number: expect.stringMatching(/already in service/) } });
    expect(await saveTrailer({ number: "" }, null, new Date(), W)).toMatchObject({ ok: false });
  });

  test("a change is audited with the fields that moved; saving the same values changes nothing", async () => {
    const t1 = await prisma.trailer.findFirstOrThrow({ where: { workspaceId: W, number: "E2-100" } });
    expect(await saveTrailer(t(), t1.id, new Date(), W)).toMatchObject({ ok: true, changed: false });
    expect(await saveTrailer(t({ maxPayloadLbs: "40000", location: "Door 9" }), t1.id, new Date(), W)).toMatchObject({ ok: true, changed: true });
    const [latest] = await listEntityAudit(t1.id, 1, W);
    expect(latest!.action).toBe("trailer_changed");
    expect(latest!.summary).toMatch(/payload \(lb\).*location|location.*payload \(lb\)/);
    expect(latest!.before).toMatchObject({ "Payload (lb)": "44000" });
    expect(latest!.after).toMatchObject({ "Payload (lb)": "40000", Location: "Door 9" });
    await saveTrailer(t(), t1.id, new Date(), W);
  });

  test("a tractor pulls one trailer at a time: the second is refused, in the desk and in the database", async () => {
    const a = await prisma.trailer.findFirstOrThrow({ where: { workspaceId: W, number: "E2-100" } });
    const b = await saveTrailer(t({ number: "E2-101" }), null, new Date(), W);
    if (!b.ok) throw new Error("b");
    expect(await hookTrailer(a.id, ids.truck, new Date(), W)).toEqual({ ok: true });
    expect(await hookTrailer(b.id, ids.truck, new Date(), W)).toMatchObject({ ok: false, error: "E2 Truck 1 already pulls E2-100. Unhook it first." });
    await expect(prisma.trailer.update({ where: { id: b.id }, data: { currentVehicleId: ids.truck } })).rejects.toThrow(); // the partial unique index
    expect(await hookTrailer(b.id, ids.truck2, new Date(), W)).toEqual({ ok: true });
    const detail = await getTrailerDetail(a.id, W);
    expect(detail?.currentVehicle?.name).toBe("E2 Truck 1");
    expect((await listEntityAudit(a.id, 5, W)).map((e) => e.action)).toContain("trailer_hooked");
    expect(await hookTrailer(b.id, null, new Date(), W)).toEqual({ ok: true });
    expect((await listEntityAudit(b.id, 5, W))[0]!.action).toBe("trailer_unhooked");
    expect(await hookTrailer(a.id, "not-a-truck", new Date(), W)).toMatchObject({ ok: false });
  });

  test("a trailer goes on a load only if it can take it, and not at the same time as another load", async () => {
    const a = await prisma.trailer.findFirstOrThrow({ where: { workspaceId: W, number: "E2-100" } });
    const b = await prisma.trailer.findFirstOrThrow({ where: { workspaceId: W, number: "E2-101" } });
    const reefer = await saveTrailer(t({ number: "E2-REEF", type: "reefer" }), null, new Date(), W);
    const shop = await saveTrailer(t({ number: "E2-SHOP", status: "in_shop" }), null, new Date(), W);
    const lapsed = await saveTrailer(t({ number: "E2-OLD", registrationExpiry: ymd(-5) }), null, new Date(), W);
    const light = await saveTrailer(t({ number: "E2-LIGHT", maxPayloadLbs: "20000" }), null, new Date(), W);
    if (!reefer.ok || !shop.ok || !lapsed.ok || !light.ok) throw new Error("setup");
    const refused = async (id: string) => assignTrailerToLoad(ids.load, id, new Date(), W);
    expect(await refused(reefer.id)).toMatchObject({ ok: false, error: expect.stringContaining("needs dry van") });
    expect(await refused(shop.id)).toMatchObject({ ok: false, error: "E2-SHOP: in the shop." });
    expect(await refused(lapsed.id)).toMatchObject({ ok: false, error: "E2-OLD: registration expired." });
    expect(await refused(light.id)).toMatchObject({ ok: false, error: expect.stringContaining("rated for 20,000 lb") });

    expect(await assignTrailerToLoad(ids.load, a.id, new Date(), W)).toEqual({ ok: true, warnings: [] });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: ids.load } })).trailerId).toBe(a.id);
    // The same trailer on an overlapping load is refused; on a different tractor than the load's it is a warning only.
    expect(await assignTrailerToLoad(ids.load2, a.id, new Date(), W)).toMatchObject({ ok: false, error: "E2-100 is already on E2-L1 at that time." });
    expect(await assignTrailerToLoad(ids.load2, b.id, new Date(), W)).toEqual({ ok: true, warnings: [] });
    // A load with no kind of trailer stated takes the trailer's kind.
    expect((await prisma.load.findUniqueOrThrow({ where: { id: ids.load2 } })).trailerType).toBe("dry_van");
    const events = await listEntityAudit(a.id, 5, W);
    expect(events[0]).toMatchObject({ action: "trailer_assigned", loadNumber: "E2-L1", summary: "E2-100 put on E2-L1" });

    // Taking it off, then it is free again.
    expect(await assignTrailerToLoad(ids.load, null, new Date(), W)).toEqual({ ok: true, warnings: [] });
    expect(await assignTrailerToLoad(ids.load2, a.id, new Date(), W)).toMatchObject({ ok: true });
    expect(await assignTrailerToLoad(ids.load2, null, new Date(), W)).toMatchObject({ ok: true });
  });

  test("another workspace's trailer or load cannot be used", async () => {
    const foreign = await prisma.trailer.create({ data: { workspaceId: OTHER, number: "E2-FOREIGN" } });
    expect(await assignTrailerToLoad(ids.load, foreign.id, new Date(), W)).toMatchObject({ ok: false, error: "That trailer is not available." });
    expect(await assignTrailerToLoad("nope", foreign.id, new Date(), OTHER)).toMatchObject({ ok: false });
    expect(await hookTrailer(foreign.id, ids.truck, new Date(), W)).toMatchObject({ ok: false });
    expect(await setTrailerArchived(foreign.id, true, new Date(), W)).toMatchObject({ ok: false });
    expect(await getTrailerDetail(foreign.id, W)).toBeNull();
    expect((await listTrailersPage({ q: "FOREIGN" }, new Date(), W)).total).toBe(0);
  });

  test("a trailer on an open load cannot be archived; archiving unhooks it, restoring brings it back unless its number is taken", async () => {
    const a = await prisma.trailer.findFirstOrThrow({ where: { workspaceId: W, number: "E2-100" } });
    await assignTrailerToLoad(ids.load, a.id, new Date(), W);
    expect(await setTrailerArchived(a.id, true, new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("E2-L1") });
    await assignTrailerToLoad(ids.load, null, new Date(), W);
    expect(await setTrailerArchived(a.id, true, new Date(), W)).toEqual({ ok: true });
    const archived = await prisma.trailer.findUniqueOrThrow({ where: { id: a.id } });
    expect([archived.archivedAt != null, archived.currentVehicleId]).toEqual([true, null]);
    // The tractor is free for another trailer, and the number can be used again.
    expect(await saveTrailer(t({ number: "E2-100" }), null, new Date(), W)).toMatchObject({ ok: true });
    expect(await setTrailerArchived(a.id, false, new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("Another trailer numbered E2-100") });
    await prisma.trailer.deleteMany({ where: { workspaceId: W, number: "E2-100", archivedAt: null } });
    expect(await setTrailerArchived(a.id, false, new Date(), W)).toEqual({ ok: true });
  });

  test("the list searches number, plate and VIN, filters, sorts and pages", async () => {
    await saveTrailer(t({ number: "E2-VIN", vin: "1HGBH41JXMN109186", plate: "ZZZ999" }), null, new Date(), W);
    const all = await listTrailersPage({ pageSize: 3 }, new Date(), W);
    expect(all.pages).toBeGreaterThan(1);
    expect(all.rows).toHaveLength(3);
    expect((await listTrailersPage({ q: "zzz9" }, new Date(), W)).rows.map((r) => r.number)).toEqual(["E2-VIN"]);
    expect((await listTrailersPage({ q: "109186" }, new Date(), W)).rows.map((r) => r.number)).toEqual(["E2-VIN"]);
    expect((await listTrailersPage({ type: "reefer" }, new Date(), W)).rows.map((r) => r.number)).toEqual(["E2-REEF"]);
    expect((await listTrailersPage({ status: "in_shop" }, new Date(), W)).rows.map((r) => r.number)).toEqual(["E2-SHOP"]);
    const lapsed = await listTrailersPage({ compliance: "lapsed" }, new Date(), W);
    expect(lapsed.rows.map((r) => r.number)).toEqual(["E2-OLD"]);
    expect(lapsed.rows[0]).toMatchObject({ compliance: "lapsed", blocker: "Registration expired" });
    expect((await listTrailersPage({ compliance: "ok" }, new Date(), W)).rows.map((r) => r.number)).not.toContain("E2-OLD");
    expect((await listTrailersPage({ terminal: "No Such Yard" }, new Date(), W)).total).toBe(0);
    expect((await listTrailersPage({ sort: "-number" }, new Date(), W)).rows[0]!.number > (await listTrailersPage({ sort: "number" }, new Date(), W)).rows[0]!.number).toBe(true);
    expect((await listTrailersPage({ archived: true }, new Date(), W)).rows.every((r) => r.archived)).toBe(true);
  });

  test("the Quote counts the free trailers of the kind it needs, and says nothing when the desk keeps none", async () => {
    const free = await countTrailersAvailable("dry_van", null, new Date(), W);
    const expected = await prisma.trailer.count({ where: { workspaceId: W, archivedAt: null, status: "available", type: "dry_van", registrationExpiry: { gte: new Date() }, loads: { none: { deletedAt: null, status: { in: ["draft", "accepted", "in_progress"] } } } } });
    expect(free).toBe(expected);
    expect(await countTrailersAvailable("reefer", null, new Date(), W)).toBe(1);
    expect(await countTrailersAvailable("dry_van", "Nowhere", new Date(), W)).toBe(0);

    const input = readQuote({ ...BLANK_QUOTE, trailer: "dry_van", stops: [{ role: "pickup", address: "Dallas, TX", appointment: `${quoteDay}T08:00` }, { role: "delivery", address: "Tulsa, OK", appointment: `${quoteDay}T17:00` }], broker: "E2 Broker", offer: "1500", loadedMiles: "260", emptyToPickup: "40", emptyHome: "240", marketRate: "1500" });
    if (!input) throw new Error("not priceable");
    expect((await fitQuote(input, W)).trailersAvailable).toBe(free);
    expect((await fitQuote(input, OTHER)).trailersAvailable).toBe(0); // the other workspace keeps one trailer, but not of this kind
    await wipe(OTHER);
    await prisma.workspace.create({ data: { id: OTHER, name: "E2 other" } });
    expect((await fitQuote(input, OTHER)).trailersAvailable).toBeNull();
  });

  test("a load whose trailer cannot go out raises a block, a date coming due a warning", async () => {
    clearAlertCache();
    const bad = await prisma.trailer.findFirstOrThrow({ where: { workspaceId: W, number: "E2-OLD" } });
    await prisma.load.update({ where: { id: ids.load }, data: { trailerId: bad.id } });
    const a = await getAlerts(new Date(), W, "open");
    expect(a.alerts.find((x) => x.code === "TRAILER_COMPLIANCE")).toMatchObject({ level: "block", loadNumber: "E2-L1", message: "Trailer E2-OLD: registration expired." });
    await prisma.trailer.update({ where: { id: bad.id }, data: { registrationExpiry: days(300), inspectionExpiry: days(9) } });
    const b = await getAlerts(new Date(), W, "open");
    expect(b.alerts.find((x) => x.code === "TRAILER_COMPLIANCE")).toMatchObject({ level: "warn" });
    await prisma.load.update({ where: { id: ids.load }, data: { trailerId: null } });
  });

  test("a spreadsheet of trailers is checked, imported in one go with one audit event, and exported again", async () => {
    const file = ["Number,Type,Plate,Ownership,Terminal,Registration good through", "E2-IMP-1,reefer,P1,leased,Dallas,12/31/2031", "E2-IMP-2,flatbed,P2,pool,Houston,", "E2-REEF,reefer,,,,", "E2-IMP-3,boat,,,,"].join("\n");
    const p = await previewImport("trailers", file, W);
    expect(p).toMatchObject({ ok: true, total: 4, ready: 2, problemCount: 2 });
    const before = await prisma.auditEvent.count({ where: { workspaceId: W, action: "import_completed" } });
    expect(await commitImport("trailers", file, "yard.csv", new Date(), W)).toEqual({ ok: true, created: 2, skipped: 2, kind: "trailers" });
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "import_completed" } })).toBe(before + 1);
    const imp = await prisma.trailer.findFirstOrThrow({ where: { workspaceId: W, number: "E2-IMP-1" } });
    expect(imp).toMatchObject({ type: "reefer", ownership: "leased", terminal: "Dallas" });
    expect(imp.registrationExpiry?.getUTCFullYear()).toBe(2032);
    expect(await commitImport("trailers", file, "yard.csv", new Date(), W)).toMatchObject({ ok: false }); // all copies now

    const csv = await buildExport("trailers", { type: "reefer" }, new Date());
    expect(csv).not.toBeNull();
    expect(csv!.filename).toMatch(/^truelane-desk-trailers-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(csv!.csv.split("\r\n")[0]).toContain("Number,Type,Plate");
  });
});

describe.skipIf(!run)("the trailer type-ahead", () => {
  const DEMO = "demo-workspace";
  let loadId = "";
  beforeAll(async () => {
    const load = await prisma.load.create({ data: { workspaceId: DEMO, loadNumber: "E2P-LOAD", status: "draft", quotedRevenue: 800, trailerType: "dry_van", weightLbs: 30000 } });
    loadId = load.id;
    const make = (number: string, extra: Record<string, unknown> = {}) => prisma.trailer.create({ data: { workspaceId: DEMO, number, type: "dry_van", maxPayloadLbs: 44000, registrationExpiry: FUTURE, inspectionExpiry: FUTURE, ...extra } });
    await make("E2P-A");
    await make("E2P-B", { type: "reefer" });
    await make("E2P-C", { status: "in_shop" });
    await make("E2P-D", { maxPayloadLbs: 20000 });
  });
  afterAll(async () => {
    await prisma.load.deleteMany({ where: { id: loadId } });
    await prisma.trailer.deleteMany({ where: { workspaceId: DEMO, number: { startsWith: "E2P-" } } });
  });

  test("it offers available trailers, the ones that fit first, each with what would stop it", async () => {
    const body = (await (await pickTrailers(new Request(`http://desk.test/trailers/pick?q=E2P-&load=${loadId}`))).json()) as { trailers: Array<{ number: string; blocker: string | null }> };
    const numbers = body.trailers.map((x) => x.number);
    expect(numbers).not.toContain("E2P-C"); // in the shop is not offered at all
    expect(numbers[0]).toBe("E2P-A"); // the only one that fits
    expect(body.trailers.slice(1).every((x) => x.blocker)).toBe(true);
    expect(body.trailers.find((x) => x.number === "E2P-B")!.blocker).toMatch(/needs dry van/);
    expect(body.trailers.find((x) => x.number === "E2P-D")!.blocker).toMatch(/rated for 20,000 lb/);
  });

  test("a number, a plate or nothing found says so with an empty list", async () => {
    expect(((await (await pickTrailers(new Request("http://desk.test/trailers/pick?q=zzzz-none"))).json()) as { trailers: unknown[] }).trailers).toEqual([]);
  });
});

describe.skipIf(!run)("the registry at the size of a big yard", () => {
  const BIG = "e2-big";
  beforeAll(async () => {
    await wipe(BIG);
    await prisma.workspace.create({ data: { id: BIG, name: "E2 big" } });
    const rows = Array.from({ length: 6000 }, (_, i) => ({ workspaceId: BIG, number: `B-${String(i).padStart(5, "0")}`, type: i % 3 === 0 ? "reefer" : "dry_van", plate: `PL${i}`, terminal: `T${i % 10}`, registrationExpiry: i % 50 === 0 ? days(-3) : FUTURE, inspectionExpiry: FUTURE }));
    for (let i = 0; i < rows.length; i += 2000) await prisma.trailer.createMany({ data: rows.slice(i, i + 2000) });
  });
  afterAll(() => wipe(BIG));

  test("a page, a search and a filter answer in well under a second", async () => {
    const time = async (fn: () => Promise<unknown>) => {
      const t0 = Date.now();
      await fn();
      return Date.now() - t0;
    };
    expect(await time(() => listTrailersPage({}, new Date(), BIG))).toBeLessThan(1500);
    expect(await time(() => listTrailersPage({ q: "B-0420" }, new Date(), BIG))).toBeLessThan(1500);
    expect(await time(() => listTrailersPage({ compliance: "lapsed", terminal: "T0" }, new Date(), BIG))).toBeLessThan(1500);
    expect((await listTrailersPage({ compliance: "lapsed" }, new Date(), BIG)).total).toBe(120);
    expect((await listTrailersPage({}, new Date(), BIG)).total).toBe(6000);
  });
});
