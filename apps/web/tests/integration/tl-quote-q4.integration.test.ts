import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { BLANK_QUOTE, type QuoteValues } from "@/lib/quote";
import { listQuotes, saveQuote } from "@/server/tl/quote";

/** Quote Q4 on the demo database: a saved quote whose pickup has gone by is marked and can be listed on its own; it stays open (marked only). */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";
const BROKER = "Q4 Broker";

describe.skipIf(!run)("Quote Q4 on the demo database", () => {
  const startedAt = new Date();
  const quote = (day: string): QuoteValues => ({
    ...BLANK_QUOTE,
    stops: [
      { role: "pickup", address: "Dallas, TX", appointment: `${day}T08:00` },
      { role: "delivery", address: "Tulsa, OK", appointment: `${day}T17:00` }
    ],
    broker: BROKER,
    offer: "1500",
    loadedMiles: "260"
  });

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { createdAt: { gte: startedAt }, summary: { contains: BROKER } } });
    await prisma.load.deleteMany({ where: { workspaceId: WS, brokerName: BROKER } });
  });

  let past = "";
  let ahead = "";
  beforeAll(async () => {
    const a = await saveQuote(quote("2026-01-05"), null, null);
    const b = await saveQuote(quote("2032-01-05"), null, null);
    if (!a.ok || !b.ok) throw new Error("save");
    past = a.id;
    ahead = b.id;
  });

  test("a quote whose pickup has gone by is listed under Pickup passed, still open, with its pickup day", async () => {
    const gone = await listQuotes(WS, { q: BROKER, status: "past" });
    expect(gone.rows.map((r) => r.id)).toEqual([past]);
    const open = await listQuotes(WS, { q: BROKER, status: "open" });
    expect(open.rows.map((r) => r.id).sort()).toEqual([past, ahead].sort());
    const row = open.rows.find((r) => r.id === past)!;
    expect(row.pickupAt?.toISOString().slice(0, 10)).toBe("2026-01-05");
    expect(row.passedFor).toBeNull();
  });
});
