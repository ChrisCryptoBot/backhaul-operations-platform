import { beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { assertDriverSafe } from "@/server/tl/projector";
import { assignDriver, dispatchLoad, DispatchError, driverBlocker, driverSummaryFor, recordDriverResponse } from "@/server/tl/dispatch";
import { agingFor, analyticsFor, listBoardRows } from "@/server/tl/queries";
import { saveReviewedDraft } from "@/server/ratecon/save";
import { readRateCon } from "@/server/ratecon/reader";

/**
 * Runs against a database seeded by scripts/seed-demo.ts:
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/tl-dispatch.integration.test.ts
 * It writes to that database, so it is skipped unless RUN_DB_INTEGRATION=true.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";

describe.skipIf(!run)("dispatcher flow on the TrueLane-shaped tables", () => {
  let draftLoadId = "";
  let driverId = "";

  beforeAll(async () => {
    const load = await prisma.tlLoad.findFirstOrThrow({ where: { loadNumber: "DM-40001" } });
    draftLoadId = load.id;
    await prisma.tlAssignment.deleteMany({ where: { loadId: draftLoadId } });
    await prisma.tlLoad.update({ where: { id: draftLoadId }, data: { status: "draft" } });
    driverId = (await prisma.tlDriver.findFirstOrThrow({ where: { name: "Alex Rivera" } })).id;
  });

  test("the board shows the deadhead-trap load rejected at its real miles", async () => {
    const row = (await listBoardRows()).find((r) => r.loadNumber === "DM-40001")!;
    expect(row.totalMiles).toBeCloseTo(545.2, 1);
    expect(row.perMile).toBeCloseTo(1.19, 2);
    expect(row.verdict).toBe("reject");
  });

  test("assign, send, and record the driver's answer; the driver payload never carries revenue", async () => {
    const a = await assignDriver({ loadId: draftLoadId, driverId, pay: { kind: "cpm", rate: 0.65 } });
    expect(a.status).toBe("draft");
    expect(Number(a.payEstimate)).toBeCloseTo(167.18, 2);

    const sent = await dispatchLoad(draftLoadId);
    expect(sent.assignment.status).toBe("dispatched");
    expect(() => assertDriverSafe(sent.summary, { numbers: [650] })).not.toThrow();
    expect(JSON.stringify(await driverSummaryFor(draftLoadId))).not.toMatch(/650|revenue|margin|rate_?con/i);

    await expect(dispatchLoad(draftLoadId)).rejects.toMatchObject({ code: "already_sent" });
    const answered = await recordDriverResponse(draftLoadId, "accepted");
    expect(answered.status).toBe("accepted");
    expect((await prisma.tlLoad.findUniqueOrThrow({ where: { id: draftLoadId } })).status).toBe("accepted");
  });

  test("a driver with a lapsed card cannot be assigned", async () => {
    expect(driverBlocker({ cdlExpiry: new Date("2020-01-01"), medicalCardExpiry: null })).toBe("CDL expired");
    const lapsed = await prisma.tlDriver.create({ data: { workspaceId: "demo-workspace", name: "Lapsed Test", cdlExpiry: new Date("2020-01-01") } });
    const other = await prisma.tlLoad.findFirstOrThrow({ where: { status: "draft", assignment: null } });
    await expect(assignDriver({ loadId: other.id, driverId: lapsed.id, pay: { kind: "flat", rate: 300 } })).rejects.toBeInstanceOf(DispatchError);
    await prisma.tlDriver.delete({ where: { id: lapsed.id } });
  });

  test("analytics and aging compute from the tables with TrueLane's math", async () => {
    const a = await analyticsFor("all");
    expect(a.summary.loadCount).toBe(30);
    expect(a.summary.avgRpm).toBeGreaterThan(0);
    const aging = await agingFor();
    expect(aging.count).toBeGreaterThan(0);
  });

  test("a read rate confirmation becomes a draft load only after review", async () => {
    const out = await readRateCon({ fileName: "RC-AFB-482913.pdf" }, {});
    if (!out.ok) throw new Error("expected a reading");
    await expect(saveReviewedDraft({ ...out.draft, confirmed: false })).rejects.toThrow(/reviewed/);
    const saved = await saveReviewedDraft({ ...out.draft, confirmed: true });
    expect(saved.stops).toHaveLength(2);
    expect(saved.status).toBe("draft");
    await prisma.tlLoad.delete({ where: { id: saved.id } });
  });
});
