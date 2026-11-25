import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { driverIsContractor, driverSummaryFor } from "@/server/tl/dispatch";

/**
 * Finalization plan F2 (sync plan Step 5c) on the demo database: a contractor's summary carries their load's gross and the fee; an employee's never does.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/contractor-money.integration.test.ts
 * It makes its own driver, load and link code, and takes them away again.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";

describe.skipIf(!run)("contractor money in the driver summary", () => {
  const ws = currentWorkspaceId();
  const now = new Date();
  let driverId = "";
  let loadId = "";

  const code = (role: string, o: { claimed?: boolean; revoked?: boolean } = {}) =>
    prisma.driverLinkInvite.create({
      data: { workspaceId: ws, driverId, codeHash: `test-contractor-${role}-${Math.random()}`, driverRole: role, expiresAt: new Date(now.getTime() + 86_400_000), claimedAt: o.claimed === false ? null : new Date(), claimedBy: "user_test_contractor", revokedAt: o.revoked ? new Date() : null }
    });

  beforeAll(async () => {
    driverId = (await prisma.driver.create({ data: { workspaceId: ws, name: "Contractor Test", payrollWorkerType: "contractor" } })).id;
    const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = await prisma.load.findFirstOrThrow({ where: { workspaceId: ws, loadNumber: "DM-40006" } });
    void _i; void _c; void _u;
    loadId = (await prisma.load.create({ data: { ...(rest as object), loadNumber: "CTR-1", status: "assigned", quotedRevenue: 2000, fuelSurcharge: 150, loadedMiles: 400, assignment: { create: { driverId, payKind: "percent", payRate: 75, status: "draft" } } } as never })).id;
  });

  afterAll(async () => {
    await prisma.driverLinkInvite.deleteMany({ where: { driverId } });
    await prisma.assignment.deleteMany({ where: { driverId } });
    await prisma.load.deleteMany({ where: { id: loadId } });
    await prisma.driver.delete({ where: { id: driverId } });
  });

  test("no link, a withdrawn link or an unclaimed code is an employee: no gross, no fee", async () => {
    expect(await driverIsContractor(driverId, ws)).toBe(false);
    await code("owner_op_leased", { revoked: true });
    await code("owner_op_leased", { claimed: false });
    expect(await driverIsContractor(driverId, ws)).toBe(false);
    expect((await driverSummaryFor(loadId, ws)).contractor).toBeUndefined();
  });

  test("an employee's live link: still nothing", async () => {
    await code("company");
    expect((await driverSummaryFor(loadId, ws)).contractor).toBeUndefined();
  });

  test("a contractor's live link: the agreed rate plus fuel surcharge as gross, and 100 - their percent as the fee", async () => {
    await prisma.driverLinkInvite.updateMany({ where: { driverId }, data: { revokedAt: new Date() } });
    await code("owner_op_leased");
    const s = await driverSummaryFor(loadId, ws);
    expect(s.contractor).toEqual({ gross: 2150, fee_pct: 25 });
    expect(s.driver_pay).toMatchObject({ kind: "flat", rate: 1612.5 });
  });

  test("Addendum P.1: explicit desk payArrangement overrides the phone link role", async () => {
    await prisma.driver.update({ where: { id: driverId }, data: { payArrangement: "company" } });
    expect(await driverIsContractor(driverId, ws)).toBe(false);
    expect((await driverSummaryFor(loadId, ws)).contractor).toBeUndefined();

    await prisma.driverLinkInvite.updateMany({ where: { driverId }, data: { revokedAt: new Date() } });
    await prisma.driver.update({ where: { id: driverId }, data: { payArrangement: "contractor" } });
    expect(await driverIsContractor(driverId, ws)).toBe(true);
    expect((await driverSummaryFor(loadId, ws)).contractor).toEqual({ gross: 2150, fee_pct: 25 });

    await prisma.driver.update({ where: { id: driverId }, data: { payArrangement: null } });
  });
});
