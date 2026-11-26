import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { BLANK_QUOTE, readQuote } from "@/lib/quote";
import { brokerNames, quoteContext } from "@/server/tl/quote";

/**
 * Quote Q4: what the desk knows about the customer is read on every price, so a customer of years (thousands of loads) must not slow typing down. Gives one customer 3,000 finished loads on
 * the big fleet, then times the read. Run with:
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_scale RUN_SCALE=true npx vitest run tests/perf/quote-context.perf.test.ts
 */
const run = process.env.RUN_SCALE === "true";
const NAME = "Perf Q4 Customer";
const COUNT = 3000;

describe.skipIf(!run)("the customer record on a price, for a customer of years", () => {
  let ws = "";
  beforeAll(async () => {
    ws = (await prisma.workspace.findFirstOrThrow({ select: { id: true } })).id;
    await prisma.load.deleteMany({ where: { workspaceId: ws, brokerName: NAME } });
    const day = 86_400_000;
    const base = Date.UTC(2026, 0, 1);
    const rows = Array.from({ length: COUNT }, (_, i) => ({
      workspaceId: ws,
      loadNumber: `PQ4-${i}`,
      status: "completed",
      brokerName: NAME,
      originAddress: "Dallas, TX",
      destinationAddress: "Tulsa, OK",
      quotedRevenue: 1200 + (i % 50),
      fuelSurcharge: 100,
      loadedMiles: 260,
      completedAt: new Date(base + (i % 300) * day),
      invoicedAt: new Date(base + (i % 300) * day),
      paidAt: new Date(base + ((i % 300) + 30) * day),
      paymentStatus: "paid"
    }));
    for (let i = 0; i < rows.length; i += 500) await prisma.load.createMany({ data: rows.slice(i, i + 500) });
  }, 120_000);
  afterAll(async () => {
    await prisma.load.deleteMany({ where: { workspaceId: ws, brokerName: NAME } });
  });

  test("the lane and customer record come back fast, and whole", async () => {
    const input = readQuote({ ...BLANK_QUOTE, stops: [{ role: "pickup", address: "Dallas, TX", appointment: "" }, { role: "delivery", address: "Tulsa, OK", appointment: "" }], broker: NAME, offer: "1500", loadedMiles: "260" })!;
    await quoteContext(input, ws); // warm
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = Date.now();
      const ctx = await quoteContext(input, ws);
      runs.push(Date.now() - t);
      expect(ctx.broker).toMatchObject({ name: NAME, loads: 1000, finished: 1000 });
      expect(ctx.broker!.averageDaysToPay).toBeCloseTo(30, 0);
    }
    const median = runs.sort((a, b) => a - b)[2]!;
    expect(median).toBeLessThan(300);
  });

  test("the customer list's slow-pay read stays bounded", async () => {
    const t = Date.now();
    const list = await brokerNames(ws, null);
    expect(list.some((c) => c.name === NAME)).toBe(true);
    expect(Date.now() - t).toBeLessThan(1500);
  });
});
