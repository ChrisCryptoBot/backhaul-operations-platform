import { describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { readRateCon } from "@/server/ratecon/reader";
import { listRecentRateCons } from "@/server/ratecon/recent";
import { saveReviewedDraft } from "@/server/ratecon/save";

/**
 * Runs against a database seeded by scripts/seed-demo.ts (see tl-dispatch.integration.test.ts for the command).
 * It writes one load and removes it again, so it is skipped unless RUN_DB_INTEGRATION=true.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";

describe.skipIf(!run)("the Rate confirmations list", () => {
  test("lists the loads that were read from a document, newest first, with where each stands", async () => {
    const { rows, total } = await listRecentRateCons(5);
    expect(total).toBeGreaterThanOrEqual(15); // a third of the 45 seeded loads
    expect(rows).toHaveLength(5);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.readAt.getTime()).toBeGreaterThanOrEqual(rows[i]!.readAt.getTime());
    for (const r of rows) {
      expect(r.rate).toBeGreaterThan(0);
      expect(r.loadedMiles).toBeGreaterThan(0);
      expect(r.perMile).toBeCloseTo(r.rate / r.loadedMiles, 6);
      expect(["draft", "accepted", "in_progress", "completed", "tonu", "cancelled"]).toContain(r.status);
    }
  });

  test("a document saved on the page lands at the top, as a draft that needs a driver", async () => {
    const before = (await listRecentRateCons(1)).total;
    const out = await readRateCon({ fileName: "RC-RDL-77315.pdf" }, {});
    if (!out.ok) throw new Error("expected a reading");
    const truck = await prisma.vehicle.findFirstOrThrow({ where: { archivedAt: null } });
    const saved = await saveReviewedDraft({ ...out.draft, confirmed: true, vehicleId: truck.id });
    try {
      const after = await listRecentRateCons(3);
      expect(after.total).toBe(before + 1);
      expect(after.rows[0]).toMatchObject({ id: saved.id, loadNumber: "RDL-77315", broker: "Redline Demo Logistics", stops: 3, rate: 640, status: "draft", hasDriver: false });
      expect(saved.vehicleId).toBe(truck.id);
      expect(saved.fuelSurcharge).toBeNull(); // the $65 surcharge is inside the $640
    } finally {
      await prisma.auditEvent.deleteMany({ where: { loadId: saved.id } });
      await prisma.load.delete({ where: { id: saved.id } });
    }
  });
});
