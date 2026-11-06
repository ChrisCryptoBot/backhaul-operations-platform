import { describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { clearLeakCache, getLeakLedger } from "@/server/tl/leaks";

/**
 * The Leak Ledger on the scale database (1,500 trucks, about 4,000 loads here, 50,000 in the full set): the first visit after a change builds it from a lean read of the finished loads, detention on the
 * loads that waited, the audit trail's dwell and the dropped trailers; every visit after that is a check of the data mark. A terminal's own ledger is never slower than the whole fleet's.
 *
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_scale RUN_SCALE=true npx vitest run tests/perf/leaks.perf.test.ts
 */
const run = process.env.RUN_SCALE === "true";

describe.skipIf(!run)("the leak ledger at the size of a big fleet", () => {
  test("built once, then kept; a terminal's is no slower than the whole fleet's", async () => {
    const ws = (await prisma.vehicle.findFirst({ where: { lastLat: { not: null } }, select: { workspaceId: true } }))?.workspaceId!;
    const terminal = (await prisma.vehicle.findFirst({ where: { workspaceId: ws, terminal: { not: null } }, select: { terminal: true } }))?.terminal ?? null;
    clearLeakCache();
    let t = Date.now();
    const all = await getLeakLedger({ period: "all", compare: false, terminals: null }, new Date(), ws);
    const first = Date.now() - t;
    expect(all.current.items).toBeGreaterThan(0);
    expect(first).toBeLessThan(4000);
    t = Date.now();
    await getLeakLedger({ period: "all", compare: false, terminals: null }, new Date(), ws);
    expect(Date.now() - t).toBeLessThan(300);
    if (terminal) {
      t = Date.now();
      const one = await getLeakLedger({ period: "all", compare: false, terminals: [terminal] }, new Date(), ws);
      expect(Date.now() - t).toBeLessThan(4000);
      expect(one.current.total).toBeLessThanOrEqual(all.current.total);
    }
    clearLeakCache();
    t = Date.now();
    await getLeakLedger({ period: "4w", compare: true, terminals: null }, new Date(), ws);
    expect(Date.now() - t).toBeLessThan(3000);
  });
});
