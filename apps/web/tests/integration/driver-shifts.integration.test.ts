import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { driverCodeBase } from "@/lib/driver-code";
import { BLANK_QUOTE, readQuote } from "@/lib/quote";
import { listEntityAudit } from "@/server/tl/audit";
import { assignDriver } from "@/server/tl/dispatch";
import { allocateDriverCodes } from "@/server/tl/driver-codes";
import { rankDrivers } from "@/server/tl/driver-rank";
import { commitImport, previewImport } from "@/server/tl/import";
import { getPlannerData } from "@/server/tl/planner";
import { loadInclude } from "@/server/tl/queries";
import { fitQuote } from "@/server/tl/quote";
import { applySchedule, clearSchedule, listScheduleRows, loadSchedules, removeTimeOff, saveSchedule, saveTimeOff } from "@/server/tl/shifts";
import { addTerminal, archiveTerminal, renameTerminal, setDriverCode, setDriversHome, terminalRows } from "@/server/tl/terminal-list";
import { listTerminals } from "@/server/tl/terminal";
import type { Week } from "@/lib/shifts";

/**
 * Driver shifts, driver codes and the terminal list on the demo database, in workspaces of their own: the codes the backfill and both creation paths give, the terminal list (add, rename
 * cascade, archive refusal), a schedule saved and cut under booked freight (the conflict warning, "save anyway" and its audit entry), time off, tenant isolation, the planner feed, the
 * Assign picker listing every terminal's drivers, and the Quote's shift note leaving the verdict alone. docs/DRIVER_SHIFTS.md.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "ds-shifts";
const OTHER = "ds-other";
const BACKFILL = "ds-backfill";

const wipe = (id: string) => prisma.workspace.deleteMany({ where: { id } });
const day = (s: string) => new Date(s);
const MONFRI: Week = Array.from({ length: 7 }, (_, d) => (d >= 1 && d <= 5 ? { start: 6 * 60, end: 18 * 60 } : null));
const stops = (pickup: string, delivery: string) => ({
  create: [
    { stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", timeWindowEarliest: new Date(pickup), timeWindowLatest: new Date(pickup) },
    { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Atlanta, GA", timeWindowEarliest: new Date(delivery), timeWindowLatest: new Date(delivery) }
  ]
});

describe.skipIf(!run)("driver shifts, codes and terminals", () => {
  const ids = { casey: "", mia: "", ben: "", otherDriver: "", loadFri: "", loadLate: "", loadTray: "" };

  beforeAll(async () => {
    for (const w of [W, OTHER, BACKFILL]) await wipe(w);
    for (const w of [W, OTHER, BACKFILL]) await prisma.workspace.create({ data: { id: w, name: `${w} fleet`, plan: "enterprise" } });
    const mk = (workspaceId: string, name: string, over: Record<string, unknown> = {}) => prisma.driver.create({ data: { workspaceId, name, cdlExpiry: day("2031-01-01"), medicalCardExpiry: day("2031-01-01"), ...over } });
    ids.casey = (await mk(W, "Casey Brooks", { code: "CBRO", terminal: "Dallas" })).id;
    ids.mia = (await mk(W, "Mia Night", { code: "MNIG", terminal: "Houston" })).id;
    ids.ben = (await mk(W, "Ben Noschedule", { code: "BNOS", terminal: "Houston" })).id;
    ids.otherDriver = (await mk(OTHER, "Elsewhere Person", { code: "EPER" })).id;
    // Friday 16 April 2027 (Central is UTC-5): Casey picks up at 08:00 and delivers at 15:00, inside a 06:00-18:00 shift. Mia delivers at 20:00, after one.
    const l = await prisma.load.create({ data: { workspaceId: W, loadNumber: "DS-40009", status: "accepted", quotedRevenue: 1500, stops: stops("2027-04-16T13:00:00Z", "2027-04-16T20:00:00Z") } });
    ids.loadFri = l.id;
    ids.loadLate = (await prisma.load.create({ data: { workspaceId: W, loadNumber: "DS-40011", status: "accepted", quotedRevenue: 1500, stops: stops("2027-04-16T13:00:00Z", "2027-04-17T01:00:00Z") } })).id;
    ids.loadTray = (await prisma.load.create({ data: { workspaceId: W, loadNumber: "DS-40010", status: "draft", quotedRevenue: 900, stops: stops("2027-04-14T15:00:00Z", "2027-04-14T20:00:00Z") } })).id;
    await assignDriver({ loadId: l.id, driverId: ids.casey, pay: { kind: "cpm", rate: 0.5 } }, new Date(), W);
    await assignDriver({ loadId: ids.loadLate, driverId: ids.mia, pay: { kind: "cpm", rate: 0.5 } }, new Date(), W);
  });
  afterAll(async () => {
    for (const w of [W, OTHER, BACKFILL]) await wipe(w);
  });

  test("the migration's backfill gives the oldest of two John Smiths JSMI and the next JSMI2, in the same words as the TypeScript rule", async () => {
    const mk = (name: string, createdAt: string) => prisma.driver.create({ data: { workspaceId: BACKFILL, name, createdAt: new Date(createdAt), cdlExpiry: day("2031-01-01"), medicalCardExpiry: day("2031-01-01") } });
    await mk("John Smith", "2026-01-02T00:00:00Z");
    await mk("John Smith", "2026-03-04T00:00:00Z");
    await mk("Zoë O'Neil", "2026-02-01T00:00:00Z");
    await mk("Jo Li", "2026-02-02T00:00:00Z");
    await mk("Maria Garcia Jr.", "2026-02-03T00:00:00Z");
    const sql = fs.readFileSync(path.join(__dirname, "../../../../prisma/migrations/20261127000000_driver_shifts/migration.sql"), "utf8");
    const from = sql.indexOf("WITH cleaned AS");
    const to = sql.indexOf("WHERE d.id = n.id;") + "WHERE d.id = n.id".length;
    expect(from).toBeGreaterThan(-1);
    // The migration's own statement, held to this one workspace so it cannot touch another test's drivers.
    await prisma.$executeRawUnsafe(`${sql.slice(from, to)} AND d.workspace_id = '${BACKFILL}'`);
    const rows = await prisma.driver.findMany({ where: { workspaceId: BACKFILL }, orderBy: { createdAt: "asc" } });
    const byName = (name: string) => rows.filter((r) => r.name === name).map((r) => r.code);
    expect(byName("John Smith")).toEqual(["JSMI", "JSMI2"]);
    expect(byName("Zoë O'Neil")).toEqual(["ZONE"]);
    expect(byName("Jo Li")).toEqual(["JLI"]);
    expect(byName("Maria Garcia Jr.")).toEqual(["MGAR"]);
    for (const r of rows) expect(r.code!.replace(/\d+$/, ""), r.name).toBe(driverCodeBase(r.name));
    expect(new Set(rows.map((r) => r.code)).size).toBe(rows.length);
  });

  test("a CSV import gives two Smiths in one file JSMI and JSMI2 and refuses a second driver with the same code in the database", async () => {
    await addTerminal({ name: "Dallas" }, new Date(), W);
    const file = ["Name,Phone", "John Smith,555-0101", "John Smith,555-0102", "Jane Doe,555-0103"].join("\n");
    expect(await commitImport("drivers", file, "d.csv", new Date(), W)).toMatchObject({ ok: true, created: 3 });
    const codes = (await prisma.driver.findMany({ where: { workspaceId: W, name: { in: ["John Smith", "Jane Doe"] } }, orderBy: { name: "asc" } })).map((d) => `${d.name}:${d.code}`);
    expect(codes.sort()).toEqual(["Jane Doe:JDOE", "John Smith:JSMI", "John Smith:JSMI2"]);
    // A batch is allocated against the fleet as well as itself.
    expect(await allocateDriverCodes(prisma, W, ["John Smith", "Cara Brooks"])).toEqual(["JSMI3", "CBRO2"]);
    // The database holds the line: the same code twice in one workspace is refused.
    await expect(prisma.driver.update({ where: { id: ids.mia }, data: { code: "CBRO" } })).rejects.toThrow();
  });

  test("a code is edited by id, refused when another driver holds it, cleaned to capitals, and audited", async () => {
    expect(await setDriverCode(ids.mia, "cbro", new Date(), W)).toEqual({ ok: false, error: "CBRO is already Casey Brooks's code." });
    expect(await setDriverCode(ids.mia, "x", new Date(), W)).toMatchObject({ ok: false });
    expect(await setDriverCode(ids.mia, "mn-1g", new Date(), W)).toMatchObject({ ok: true });
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: ids.mia } })).code).toBe("MN1G");
    expect(await setDriverCode(ids.mia, "MNIG", new Date(), W)).toMatchObject({ ok: true });
    expect((await listEntityAudit(ids.mia, 5, W))[0]).toMatchObject({ action: "driver_code_changed" });
    // Another workspace's driver is not found, never changed.
    expect(await setDriverCode(ids.otherDriver, "ZZZZ", new Date(), W)).toEqual({ ok: false, error: "That driver does not exist." });
  });

  test("the terminal list: names are unique ignoring case, a rename follows everyone based there, retiring is refused while they are", async () => {
    expect(await addTerminal({ name: "  dallas " }, new Date(), W)).toEqual({ ok: false, error: "Dallas is already a terminal." });
    const houston = await addTerminal({ name: "Houston", city: "Houston, TX" }, new Date(), W);
    expect(houston).toMatchObject({ ok: true });
    if (!houston.ok) return;
    await prisma.vehicle.create({ data: { workspaceId: W, name: "DS Truck", terminal: "Houston" } });
    await prisma.trailer.create({ data: { workspaceId: W, number: "DS-T1", type: "dry_van", terminal: "Houston" } });
    let row = (await terminalRows(W)).find((t) => t.name === "Houston")!;
    expect(row).toMatchObject({ drivers: 2, trucks: 1, trailers: 1 });
    expect(await archiveTerminal(houston.id!, new Date(), W)).toMatchObject({ ok: false, error: expect.stringMatching(/2 drivers, 1 truck, 1 trailer are still based at Houston\. Move them to another terminal first\./) });
    expect(await renameTerminal(houston.id!, "dallas", new Date(), W)).toEqual({ ok: false, error: "Dallas is already a terminal." });
    expect(await renameTerminal(houston.id!, "Houston North", new Date(), W)).toMatchObject({ ok: true });
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: ids.mia } })).terminal).toBe("Houston North");
    expect((await prisma.vehicle.findFirstOrThrow({ where: { workspaceId: W, name: "DS Truck" } })).terminal).toBe("Houston North");
    expect((await prisma.trailer.findFirstOrThrow({ where: { workspaceId: W, number: "DS-T1" } })).terminal).toBe("Houston North");
    row = (await terminalRows(W)).find((t) => t.name === "Houston North")!;
    expect(row).toMatchObject({ drivers: 2, trucks: 1, trailers: 1 });
    // Move everyone off, then it can be retired, and it drops out of the picker list.
    expect(await setDriversHome([ids.mia, ids.ben], "Dallas", new Date(), W)).toEqual({ ok: true });
    await prisma.vehicle.updateMany({ where: { workspaceId: W }, data: { terminal: "Dallas" } });
    await prisma.trailer.updateMany({ where: { workspaceId: W }, data: { terminal: "Dallas" } });
    expect(await archiveTerminal(houston.id!, new Date(), W)).toEqual({ ok: true });
    expect(await listTerminals(W)).not.toContain("Houston North");
    // Only a terminal on the list may be picked as a home; another workspace's drivers are not on this desk.
    expect(await setDriversHome([ids.mia], "Atlantis", new Date(), W)).toMatchObject({ ok: false, error: expect.stringMatching(/not on the list/) });
    expect(await setDriversHome([ids.otherDriver], "Dallas", new Date(), W)).toEqual({ ok: false, error: "One of those drivers is not on this desk." });
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: ids.otherDriver } })).terminal).toBeNull();
    // Put the two back at "Houston" for the picker test below.
    const back = await addTerminal({ name: "Houston" }, new Date(), W);
    expect(back).toMatchObject({ ok: true });
    expect(await setDriversHome([ids.mia, ids.ben], "Houston", new Date(), W)).toEqual({ ok: true });
  });

  test("a driver CSV that names a terminal not on the list is reported, and nothing creates it", async () => {
    const file = ["Name,Phone,Terminal", "Pat Listed,555-0201,Dallas", "Quinn Stranger,555-0202,Atlantis"].join("\n");
    const p = await previewImport("drivers", file, W);
    expect(p).toMatchObject({ ok: true, ready: 1, problemCount: 1 });
    if (p.ok) expect(p.problems[0]!.errors[0]).toMatch(/Terminal: Atlantis is not on the terminal list/);
    expect(await commitImport("drivers", file, "t.csv", new Date(), W)).toMatchObject({ ok: true, created: 1, skipped: 1 });
    expect(await prisma.terminal.count({ where: { workspaceId: W, name: "Atlantis" } })).toBe(0);
    expect((await prisma.driver.findFirstOrThrow({ where: { workspaceId: W, name: "Pat Listed" } })).terminal).toBe("Dallas");
  });

  test("a schedule is saved and audited; a driver with none stays unset; another workspace's driver is refused", async () => {
    // Mia already holds DS-40011, a delivery at 8 PM Friday: a first schedule of 06:00-18:00 is held and the load named, and she can be given it anyway.
    expect(await saveSchedule(ids.mia, MONFRI, {}, W)).toMatchObject({ ok: false, conflicts: [{ driverName: "Mia Night", loads: [{ loadNumber: "DS-40011" }] }] });
    expect(await prisma.driverSchedule.count({ where: { driverId: ids.mia } })).toBe(0);
    expect(await saveSchedule(ids.mia, MONFRI, { force: true }, W)).toEqual({ ok: true });
    expect(await saveSchedule(ids.mia, [null], {}, W)).toMatchObject({ ok: false, error: expect.stringMatching(/seven days/) });
    expect(await saveSchedule(ids.mia, MONFRI.map((s, i) => (i === 2 ? { start: 480, end: 480 } : s)), {}, W)).toMatchObject({ ok: false, error: expect.stringMatching(/seven days/) });
    expect(await saveSchedule(ids.otherDriver, MONFRI, {}, W)).toEqual({ ok: false, error: "One of those drivers is not on this desk." });
    expect(await prisma.driverSchedule.count({ where: { driverId: ids.otherDriver } })).toBe(0);
    const audit = (await listEntityAudit(ids.mia, 5, W)).find((a) => a.action === "schedule_changed")!;
    expect(audit.summary).toBe("Mia Night: shift schedule set, saved with a conflict (DS-40011)");
    expect(audit.before).toMatchObject({ Mon: "Not set" });
    expect(audit.after).toMatchObject({ Mon: "06:00–18:00 (12h)", Sat: "Off" });
    expect((await loadSchedules(W, null, "2027-04-01")).has(ids.ben)).toBe(false);
    // Another workspace never sees this workspace's schedules.
    expect((await loadSchedules(OTHER, null, "2027-04-01")).size).toBe(0);
  });

  test("cutting a schedule under booked freight is held and listed; saving anyway goes ahead and the audit entry names the load", async () => {
    // Casey works Mon-Fri 06:00-18:00 and DS-40009 (8 AM to 3 PM Friday) fits it, so a first schedule breaks nothing.
    expect(await saveSchedule(ids.casey, MONFRI, {}, W)).toEqual({ ok: true });
    // Fridays off would put the load on a day off: a new conflict.
    const fridayOff = MONFRI.map((s, i) => (i === 5 ? null : s));
    const held = await saveSchedule(ids.casey, fridayOff, {}, W);
    expect(held).toMatchObject({ ok: false });
    if (!("conflicts" in held)) throw new Error("expected conflicts");
    expect(held.conflicts).toHaveLength(1);
    expect(held.conflicts[0]!.loads).toEqual([{ loadId: ids.loadFri, loadNumber: "DS-40009" }]);
    expect(held.conflicts[0]!.text).toBe("Casey Brooks has 1 load assigned on Friday (DS-40009). Setting to Off Duty will create a shift conflict for dispatch.");
    expect((await prisma.driverSchedule.findUniqueOrThrow({ where: { driverId: ids.casey } })).week).toEqual(MONFRI);
    expect(await saveSchedule(ids.casey, fridayOff, { force: true }, W)).toEqual({ ok: true });
    const entry = (await listEntityAudit(ids.casey, 5, W)).find((a) => a.action === "schedule_changed")!;
    expect(entry.summary).toContain("saved with a conflict (DS-40009)");
    expect(entry.after).toMatchObject({ "Conflicting loads": "DS-40009", Fri: "Off" });
    // Time off on the one date, held the same way, then removed.
    expect(await saveSchedule(ids.casey, MONFRI, { force: true }, W)).toEqual({ ok: true });
    const off = await saveTimeOff(ids.casey, { dateKey: "2027-04-16", kind: "off", note: "Home time" }, {}, W);
    expect(off).toMatchObject({ ok: false, conflicts: [{ driverName: "Casey Brooks" }] });
    expect(await saveTimeOff(ids.casey, { dateKey: "2027-04-16", kind: "off", note: "Home time" }, { force: true }, W)).toEqual({ ok: true });
    expect((await listEntityAudit(ids.casey, 5, W)).find((a) => a.action === "time_off_added")!.after).toMatchObject({ "Conflicting loads": "DS-40009", Note: "Home time" });
    // Taking the day off back restores the weekly shift: nothing new is broken, so no hold.
    expect(await removeTimeOff(ids.casey, "2027-04-16", {}, W)).toEqual({ ok: true });
    expect(await prisma.driverShiftException.count({ where: { driverId: ids.casey } })).toBe(0);
    // Time off needs a schedule to be a change to; a driver with none is told so.
    expect(await saveTimeOff(ids.ben, { dateKey: "2027-04-16", kind: "off" }, {}, W)).toMatchObject({ ok: false, error: expect.stringMatching(/weekly shifts first/) });
    expect(await saveTimeOff(ids.casey, { dateKey: "04/16/2027", kind: "off" }, {}, W)).toMatchObject({ ok: false });
  });

  test("the planner flags the late delivery, counts the day's loads against drivers on shift, and a driver with no schedule is neutral", async () => {
    const plan = await getPlannerData(day("2027-04-14T17:00:00Z").getTime(), day("2027-04-14T17:00:00Z").getTime(), 7, W);
    const casey = plan.rows.find((r) => r.driverId === ids.casey)!;
    expect(casey.cells.flat().find((i) => i.loadId === ids.loadFri)!.shiftFlag).toBeNull(); // 8 AM to 3 PM fits 06:00-18:00
    const flagged = plan.rows.find((r) => r.driverId === ids.mia)!.cells.flat().find((i) => i.loadId === ids.loadLate)!;
    expect(flagged.shiftFlag).toMatchObject({ tag: "EXCEEDS SHIFT END" });
    expect(flagged.shiftFlag!.words).toBe("Delivery is after the shift ends at 6:00 PM.");
    const ben = plan.rows.find((r) => r.driverId === ids.ben)!;
    expect(ben.shifts!.every((s) => s.kind === "unset")).toBe(true);
    expect(plan.rows.find((r) => r.driverId === ids.casey)!.code).toBe("CBRO");
    // Wednesday 14 April: one tray load, Casey and Mia on shift and free, the rest of the fleet (Ben and the imports) with no schedule.
    const wed = plan.balance![0]!;
    expect(wed.need).toBe(1);
    expect(wed.available).toBe(2);
    expect(wed.unscheduled).toBeGreaterThanOrEqual(1);
    // Saturday 17 April is off for both scheduled drivers: nobody is on shift, so nobody is available.
    expect(plan.balance![3]!.available).toBe(0);
    // Schedules set after the fact show in the rows: Mia is on Wednesday.
    const mia = plan.rows.find((r) => r.driverId === ids.mia)!;
    expect(mia.shifts![0]).toMatchObject({ kind: "on" });
    expect(mia.shifts![3]).toMatchObject({ kind: "off" });
  });

  test("the schedules list is one page of the active roster, searched by name or code, with the count of drivers who have none", async () => {
    const byCode = await listScheduleRows({ q: "cbro" }, Date.parse("2027-04-14T17:00:00Z"), W);
    expect(byCode.rows.map((r) => r.name)).toEqual(["Casey Brooks"]);
    const all = await listScheduleRows({ pageSize: 2 }, Date.parse("2027-04-14T17:00:00Z"), W);
    expect(all.pages).toBeGreaterThan(1);
    expect(all.rows).toHaveLength(2);
    expect(all.unset).toBeGreaterThanOrEqual(2);
    expect((await listScheduleRows({}, Date.parse("2027-04-14T17:00:00Z"), OTHER)).rows.map((r) => r.name)).toEqual(["Elsewhere Person"]);
  });

  test("the Assign picker lists every terminal's drivers, home drivers first, each with a code and a home; a shift is a note, never a block", async () => {
    const load = await prisma.load.findFirstOrThrow({ where: { id: ids.loadTray }, include: loadInclude });
    const scoped = await rankDrivers(load, W, "Houston");
    const names = scoped.options.map((o) => o.name);
    expect(names).toEqual(expect.arrayContaining(["Casey Brooks", "Mia Night", "Ben Noschedule"])); // Casey is based in Dallas and is still offered
    const home = ["Mia Night", "Ben Noschedule"];
    expect(names.slice(0, 2).sort()).toEqual(home.sort());
    expect(scoped.options.find((o) => o.name === "Casey Brooks")).toMatchObject({ code: "CBRO", home: "Dallas" });
    // A 15:00-20:00 UTC (10:00 to 15:00 Central, Wednesday) load is inside Mia's shift: no note. Move the delivery to 03:00 Thursday and she has one.
    expect(scoped.options.find((o) => o.name === "Mia Night")!.shiftNote).toBeNull();
    await prisma.stop.updateMany({ where: { loadId: ids.loadTray, stopType: "delivery" }, data: { timeWindowEarliest: day("2027-04-15T08:00:00Z"), timeWindowLatest: day("2027-04-15T08:00:00Z") } });
    const late = await rankDrivers(await prisma.load.findFirstOrThrow({ where: { id: ids.loadTray }, include: loadInclude }), W, null);
    const mia = late.options.find((o) => o.name === "Mia Night")!;
    expect(mia.shiftNote).toBe("Delivery is before the shift starts at 6:00 AM.");
    expect(mia.blocker).toBeNull();
    expect(late.options.find((o) => o.name === "Ben Noschedule")!.shiftNote).toBeNull();
    expect(late.options.map((o) => o.name)).not.toContain("Elsewhere Person"); // another workspace's driver is never offered
  });

  test("the Quote shows the driver's shift and a past-shift caution from the typed times, and the verdict is the same with or without a schedule", async () => {
    const truck = await prisma.vehicle.create({ data: { workspaceId: W, name: "DS Quote Truck", terminal: "Dallas", mpg: 7, costProfile: { create: { estimatedMonthlyMiles: 10000, breakEvenRpm: 1.85 } } } });
    await prisma.driver.update({ where: { id: ids.casey }, data: { assignedVehicleId: truck.id } });
    const input = readQuote({ ...BLANK_QUOTE, trailer: "dry_van", stops: [{ role: "pickup", address: "Dallas, TX", appointment: "2027-04-14T08:00" }, { role: "delivery", address: "Atlanta, GA", appointment: "2027-04-14T22:30" }], broker: "DS Broker", offer: "2500", loadedMiles: "780", emptyToPickup: "20", emptyHome: "40", marketRate: "2500" });
    if (!input) throw new Error("not priceable");
    const withShift = (await fitQuote(input, W)).rows.find((r) => r.driverId === ids.casey)!;
    expect(withShift).toBeTruthy();
    expect(withShift.shift).toMatchObject({ tag: "Shift 06:00–18:00", warn: "Past shift end (6:00 PM)" });
    await clearSchedule(ids.casey, {}, W);
    const without = (await fitQuote(input, W)).rows.find((r) => r.driverId === ids.casey)!;
    expect(without.shift).toEqual({ tag: null, warn: null, title: null });
    // Same verdict, same ranking inputs, same warnings text: the shift reads nothing into them.
    expect({ band: without.band, decision: without.decision, gate: without.gate, margin: without.marginPerMile, blocked: without.blocked, warnings: without.warnings }).toEqual({ band: withShift.band, decision: withShift.decision, gate: withShift.gate, margin: withShift.marginPerMile, blocked: withShift.blocked, warnings: withShift.warnings });
  });

  test("applying one schedule to several drivers is one change per driver, each audited, and a clear takes the schedule away", async () => {
    expect(await applySchedule([ids.mia, ids.ben], MONFRI, {}, W)).toEqual({ ok: true });
    expect(await prisma.driverSchedule.count({ where: { workspaceId: W } })).toBeGreaterThanOrEqual(2);
    expect(await applySchedule([ids.mia, ids.otherDriver], MONFRI, {}, W)).toEqual({ ok: false, error: "One of those drivers is not on this desk." });
    expect(await applySchedule([], MONFRI, {}, W)).toEqual({ ok: false, error: "Pick at least one driver." });
    expect((await listEntityAudit(ids.ben, 5, W)).some((a) => a.action === "schedule_changed")).toBe(true);
    expect(await clearSchedule(ids.ben, {}, W)).toEqual({ ok: true });
    expect(await prisma.driverSchedule.count({ where: { driverId: ids.ben } })).toBe(0);
    expect((await listEntityAudit(ids.ben, 5, W))[0]).toMatchObject({ summary: "Ben Noschedule: shift schedule cleared" });
  });
});
