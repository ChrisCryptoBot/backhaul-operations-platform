import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { SHOWCASE_STEPS, SHOWCASE_WORKSPACE_ID as W, type StepCard } from "@/lib/showcase";
import { resetShowcase, runShowcaseStep, showcaseSnapshot } from "@/server/partners/showcase";
import { deliverDue } from "@/server/webhooks/deliver";

/**
 * Money plan Wave 7 step 5 on the demo database: the partner showcase runs one load's life through every simulator, the outbound webhooks and the read API, in its own fleet. Each step lands
 * real figures read back from the database; nothing is written to any other workspace; it refuses to run where the simulator is not allowed; and the schedule never takes its webhook rows.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const ENV_KEYS = ["DESK_CREDENTIAL_KEY", "DESK_CREDENTIAL_KEY_PREVIOUS", "DESK_AUTH", "DESK_PARTNER_SANDBOX"] as const;
const saved: Record<string, string | undefined> = {};
const NOW = new Date("2026-11-13T18:00:00.000Z");
const fig = (cards: StepCard[], step: string) => Object.fromEntries(cards.find((c) => c.step === step)!.figures);
const others = () =>
  Promise.all([
    prisma.partnerConnection.count({ where: { workspaceId: { not: W }, provider: { in: ["motive", "highway", "project44", "wex", "promiles", "triumphpay", "gusto", "quickbooks"] }, accountLabel: "Simulator", createdAt: { gte: NOW } } }),
    prisma.partnerApiKey.count({ where: { workspaceId: { not: W }, label: "Showcase read key" } }),
    prisma.webhookEndpoint.count({ where: { workspaceId: { not: W }, url: { contains: "showcase" } } })
  ]);

async function wipe() {
  await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
  await prisma.driverLedgerEntry.deleteMany({ where: { workspaceId: W } });
  await prisma.settlement.deleteMany({ where: { workspaceId: W } });
  await prisma.assignment.deleteMany({ where: { load: { workspaceId: W } } });
  await prisma.workspace.deleteMany({ where: { id: W } });
}

describe.skipIf(!run)("Wave 7 step 5: the partner showcase", () => {
  let cards: StepCard[] = [];
  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.DESK_CREDENTIAL_KEY = randomBytes(32).toString("base64");
    await wipe();
  });
  afterAll(async () => {
    await wipe();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("refused where the simulator is not allowed (a live desk), and nothing is made", async () => {
    process.env.DESK_AUTH = "on";
    expect(await resetShowcase(NOW)).toMatchObject({ ok: false, error: expect.stringContaining("never runs on a live desk") });
    expect(await runShowcaseStep("eld", NOW)).toMatchObject({ ok: false });
    expect(await prisma.workspace.count({ where: { id: W } })).toBe(0);
    delete process.env.DESK_AUTH;
  });

  test("reset makes the showcase fleet: Pro, simulators connected with sandbox keys, one load on the road, the built-in receiver", async () => {
    const before = await others();
    const r = await resetShowcase(NOW);
    expect(r).toMatchObject({ ok: true });
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: W } });
    expect(ws.plan).toBe("pro");
    const conns = await prisma.partnerConnection.findMany({ where: { workspaceId: W } });
    expect(conns.map((c) => c.provider).sort()).toEqual(["gusto", "highway", "motive", "project44", "promiles", "triumphpay", "wex"]);
    expect(conns.every((c) => c.status === "connected")).toBe(true);
    expect(await prisma.load.count({ where: { workspaceId: W, status: "in_progress" } })).toBe(1);
    expect(await prisma.webhookEndpoint.count({ where: { workspaceId: W } })).toBe(1);
    if (r.ok) expect(r.cards.every((c) => !c.done && c.note?.includes("Simulator, not the company"))).toBe(true);
    expect(await others()).toEqual(before);
  });

  test("each step, in order, lands real figures", async () => {
    for (const step of SHOWCASE_STEPS) {
      const out = await runShowcaseStep(step, NOW);
      if (!out.ok) throw new Error(`${step}: ${out.error}`);
      cards = out.cards;
      if (step === "read_api") {
        expect(out.apiSample).toContain("GET /api/v1/invoices?limit=2");
        expect(out.apiSample).toContain('"number": "SHOW-INV-1001"');
        expect(out.apiSample).toMatch(/Authorization: Bearer tlk_test_[a-z0-9]{8}_…/);
        expect(out.apiSample).not.toMatch(/tlk_test_[a-z0-9]{8}_[A-Za-z0-9_-]{43}/); // never the key itself
      }
    }
    expect(cards.filter((c) => !c.done).map((c) => c.step)).toEqual([]);
    expect(fig(cards, "eld")["Drive left"]).toMatch(/^\d+h \d{2}m$/);
    expect(fig(cards, "vetting").Verdict).toMatch(/clear|review|failed/);
    expect(fig(cards, "tracking")["Signed events taken"]).toBe("3");
    expect(Number.parseFloat(fig(cards, "fuel").Gallons!)).toBeGreaterThan(0);
    expect(fig(cards, "ifta").Total).toMatch(/mi$/);
    expect(fig(cards, "factoring")).toMatchObject({ "Factor state": "funded", Advance: "$1665.00", Fee: "$46.25" });
    expect(fig(cards, "payroll").Cleared).toBe("paid by payroll");
    expect(fig(cards, "quickbooks")["Invoice in QuickBooks"]).toMatch(/^Id /);
    expect(Number.parseInt(fig(cards, "webhook")["Sent and verified"]!, 10)).toBeGreaterThanOrEqual(2);
    const wh = cards.find((c) => c.step === "webhook")!;
    expect(wh.code).toContain("x-truelane-signature: t=");
    expect(wh.code).toContain("Signature checked by the receiver: valid");
  });

  test("everything stayed in the showcase fleet, and a reload reads the same cards back", async () => {
    expect(await others()).toEqual([0, 0, 0]);
    const audit = await prisma.auditEvent.findMany({ where: { workspaceId: W }, select: { action: true } });
    expect(audit.length).toBeGreaterThan(5);
    const again = await showcaseSnapshot();
    expect(again.map((c) => [c.step, c.done])).toEqual(cards.map((c) => [c.step, c.done]));
  });

  test("the schedule never takes the showcase's webhook rows; the showcase delivers its own", async () => {
    const ep = await prisma.webhookEndpoint.findFirstOrThrow({ where: { workspaceId: W } });
    await prisma.webhookDelivery.create({ data: { workspaceId: W, endpointId: ep.id, eventId: "evt_show_cron", type: "payment.applied", payload: { id: "evt_show_cron" }, nextAttemptAt: NOW } });
    const out = await deliverDue({ now: new Date(NOW.getTime() + 60_000), only: undefined, limit: 500, resolver: async () => [{ address: "93.184.216.34", family: 4 }], transport: async () => ({ ok: true, status: 200 }) });
    expect(out.claimed >= 0).toBe(true);
    expect((await prisma.webhookDelivery.findFirstOrThrow({ where: { eventId: "evt_show_cron" } })).status).toBe("pending");
    expect(await runShowcaseStep("webhook", NOW)).toMatchObject({ ok: true });
    expect((await prisma.webhookDelivery.findFirstOrThrow({ where: { eventId: "evt_show_cron" } })).status).toBe("sent");
  });

  test("reset starts over cleanly, and running a later step first runs what it needs", async () => {
    expect(await resetShowcase(NOW)).toMatchObject({ ok: true });
    expect((await showcaseSnapshot()).every((c) => !c.done)).toBe(true);
    const out = await runShowcaseStep("factoring", NOW);
    expect(out).toMatchObject({ ok: true });
    if (out.ok) {
      expect(out.cards.find((c) => c.step === "tracking")!.done).toBe(true);
      expect(out.cards.find((c) => c.step === "factoring")!.done).toBe(true);
    }
  });
});
