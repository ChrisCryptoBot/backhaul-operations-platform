import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { sandboxPayrollEvent, SANDBOX_CLEAR_HOURS } from "@/server/partners/adapters/gusto";
import { webhookPath } from "@/server/partners/connections";
import { pollPayrollStatus, sendToPayroll } from "@/server/partners/payroll";
import { saveKeysAndConnect } from "@/server/partners/setup";
import { handleWebhook } from "@/server/partners/webhook";

/**
 * The payroll status poll on the simulator (docs/MONEY_PLAN.md, Wave 4 step 5, gap 12): a run sent days ago is asked about; paid marks it paid on the day it cleared, a refused worker's statement
 * is released with the reason, a run still pending leaves nothing but the time it was asked, and a webhook and the poll telling the same thing apply it once, either way round.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/payroll-poll.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "pay-poll-w";
const ENV_KEYS = ["DESK_CREDENTIAL_KEY", "DESK_AUTH", "DESK_PARTNER_SANDBOX", "GUSTO_CLIENT_ID", "GUSTO_CLIENT_SECRET", "GUSTO_WEBHOOK_SECRET"];
const saved: Record<string, string | undefined> = {};
const SECRET = "sandbox_whsec_payroll_poll";
const NOW = new Date("2026-11-12T18:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const later = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

describe.skipIf(!run)("the payroll status poll", () => {
  const realFetch = globalThis.fetch;
  let token = "";
  let n = 0;

  const statement = async (worker: string) => {
    n += 1;
    const d = await prisma.driver.create({ data: { workspaceId: W, name: `Driver ${n}`, payrollEmployeeId: worker, payrollWorkerType: "contractor" } });
    return prisma.settlement.create({ data: { workspaceId: W, driverId: d.id, number: `ST-PP-${n}`, status: "final", periodStart: new Date("2026-10-26"), periodEnd: new Date("2026-11-01"), total: 1000 + n, finalizedAt: ago(6) } });
  };
  const send = async (ids: string[], at: Date) => {
    const out = await sendToPayroll(ids, at, W);
    if (!out.ok) throw new Error(out.error);
    return out.reference;
  };
  const get = (id: string) => prisma.settlement.findUniqueOrThrow({ where: { id } });
  const audits = () => prisma.auditEvent.count({ where: { workspaceId: W, action: "partner_event" } });
  const events = () => prisma.partnerEvent.count({ where: { workspaceId: W } });
  const webhook = (kind: "payroll.paid" | "payroll.rejected", runId: string, id: string, extra: { statementId?: string; reason?: string } = {}) => {
    const e = sandboxPayrollEvent({ kind, runId, id, secret: SECRET, ...extra });
    return handleWebhook({ provider: "gusto", token, raw: e.raw, signature: e.signature, now: NOW });
  };

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.DESK_CREDENTIAL_KEY = randomBytes(32).toString("base64");
    globalThis.fetch = vi.fn(() => {
      throw new Error("the desk tried to reach the network");
    }) as unknown as typeof fetch;
    await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id: W } } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id: W } } }, { driver: { workspace: { id: W } } }] } });
    await prisma.workspace.deleteMany({ where: { id: W } });
    await prisma.workspace.create({ data: { id: W, name: "Payroll poll desk", plan: "enterprise" } });
    expect(await saveKeysAndConnect("gusto", { GUSTO_CLIENT_ID: "sandbox_gusto_id_01", GUSTO_CLIENT_SECRET: "sandbox_gusto_secret", GUSTO_WEBHOOK_SECRET: SECRET }, NOW, W)).toMatchObject({ connected: true });
    token = (await webhookPath("payroll", "gusto", W))!.split("/").pop()!;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id: W } } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id: W } } }, { driver: { workspace: { id: W } } }] } });
    await prisma.workspace.deleteMany({ where: { id: W } });
  });

  const st: Record<string, string> = {};
  const ref: Record<string, string> = {};

  test("a cleared run is marked paid on the day it cleared; a refused worker's statement is released with the reason", async () => {
    const a = await statement("w-1");
    const b = await statement("REJECT-2");
    st.a = a.id;
    st.b = b.id;
    ref.one = await send([a.id, b.id], ago(5));
    // Too fresh to ask about: sent yesterday.
    const fresh = await statement("w-3");
    st.fresh = fresh.id;
    ref.fresh = await send([fresh.id], ago(1));

    const out = await pollPayrollStatus({ now: NOW, workspaceId: W });
    expect(out).toMatchObject({ runs: 1, paid: 1, rejected: 1, pending: 0, failed: 0 });
    const paid = await get(st.a);
    expect(paid).toMatchObject({ paidMethod: "payroll", payrollReference: ref.one });
    expect(paid.paidAt!.toISOString()).toBe(new Date(ago(5).getTime() + SANDBOX_CLEAR_HOURS * 3_600_000).toISOString());
    const refused = await get(st.b);
    expect(refused).toMatchObject({ paidAt: null, payrollSentAt: null, payrollReference: null, payrollRejectReason: "The worker's bank account could not be verified." });
    expect(refused.payrollRejectedAt).not.toBeNull();
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: b.driverId } })).payrollStatus).toBe("failed");
    expect(await get(st.fresh)).toMatchObject({ payrollCheckedAt: null, paidAt: null });
    const trail = await prisma.auditEvent.findMany({ where: { workspaceId: W, action: "partner_event" }, select: { summary: true } });
    expect(trail.map((t) => t.summary).join(" | ")).toContain("found by the payroll status check");
  });

  test("a run still pending is a no-op: no event, no audit, and it is not asked again until its time", async () => {
    const p = await statement("w-4");
    st.p = p.id;
    ref.p = await send([p.id], ago(3.5));
    const [a0, e0] = [await audits(), await events()];
    expect(await pollPayrollStatus({ now: NOW, workspaceId: W })).toMatchObject({ runs: 1, pending: 1, paid: 0, rejected: 0 });
    expect(await get(st.p)).toMatchObject({ paidAt: null, payrollReference: ref.p });
    expect((await get(st.p)).payrollCheckedAt!.toISOString()).toBe(NOW.toISOString());
    expect([await audits(), await events()]).toEqual([a0, e0]);
    // Asked a moment later: not due, nothing asked.
    expect(await pollPayrollStatus({ now: later(1), workspaceId: W })).toMatchObject({ runs: 0 });
    expect([await audits(), await events()]).toEqual([a0, e0]);
  });

  test("paid after it clears: the next time it is due, the same run reads paid", async () => {
    // Sent 3.5 days before NOW, it clears 4 days after: half a day after NOW. Twelve hours after the last check it is due again, and has cleared.
    const out = await pollPayrollStatus({ now: later(13), workspaceId: W });
    expect(out).toMatchObject({ runs: 1, paid: 1 });
    expect(await get(st.p)).toMatchObject({ paidMethod: "payroll" });
  });

  test("the webhook first, then the poll: the poll finds nothing to ask about", async () => {
    const q = await statement("w-5");
    ref.q = await send([q.id], ago(5));
    expect(await webhook("payroll.paid", ref.q, "evt_q_paid")).toMatchObject({ status: 200, body: { result: "applied" } });
    const a0 = await audits();
    expect(await pollPayrollStatus({ now: later(30), workspaceId: W })).toMatchObject({ runs: 0 });
    expect(await audits()).toBe(a0);
    expect(await get(q.id)).toMatchObject({ paidMethod: "payroll" });
  });

  test("the poll first, then the webhook: the webhook is recorded and moves nothing; the poll's own event, told again, is a duplicate", async () => {
    const r = await statement("w-6");
    ref.r = await send([r.id], ago(5));
    expect(await pollPayrollStatus({ now: later(30), workspaceId: W })).toMatchObject({ runs: 1, paid: 1 });
    const paidAt = (await get(r.id)).paidAt!;
    const a0 = await audits();
    expect(await webhook("payroll.paid", ref.r, "evt_r_paid")).toMatchObject({ status: 200, body: { result: "ignored" } });
    expect(await audits()).toBe(a0);
    expect((await get(r.id)).paidAt!.toISOString()).toBe(paidAt.toISOString());
    // The same poll event again (forced: the statement made to look unpaid and unasked): the event id is already recorded, so nothing is applied a second time.
    await prisma.settlement.update({ where: { id: r.id }, data: { paidAt: null, paidMethod: null, payrollCheckedAt: null } });
    expect(await pollPayrollStatus({ now: later(30), workspaceId: W })).toMatchObject({ runs: 1, paid: 0, duplicate: 1 });
    expect(await audits()).toBe(a0);
    expect(await get(r.id)).toMatchObject({ paidAt: null });
    await prisma.settlement.update({ where: { id: r.id }, data: { paidAt, paidMethod: "payroll" } });
  });

  test("a refusal by webhook releases just the named statement, once; sending it again clears the refusal", async () => {
    const s1 = await statement("w-7");
    const s2 = await statement("w-8");
    ref.s = await send([s1.id, s2.id], ago(1));
    expect(await webhook("payroll.rejected", ref.s, "evt_s_rej", { statementId: s1.id, reason: "Closed account." })).toMatchObject({ body: { result: "applied" } });
    expect(await get(s1.id)).toMatchObject({ payrollReference: null, payrollRejectReason: "Closed account." });
    expect(await get(s2.id)).toMatchObject({ payrollReference: ref.s, payrollRejectedAt: null });
    const a0 = await audits();
    expect(await webhook("payroll.rejected", ref.s, "evt_s_rej")).toMatchObject({ body: { result: "duplicate" } });
    expect(await webhook("payroll.rejected", ref.s, "evt_s_rej_2", { statementId: s1.id, reason: "Closed account." })).toMatchObject({ body: { result: "ignored" } });
    expect(await audits()).toBe(a0);
    await prisma.driver.update({ where: { id: s1.driverId }, data: { payrollEmployeeId: "w-7b" } });
    await send([s1.id], NOW);
    expect(await get(s1.id)).toMatchObject({ payrollRejectedAt: null, payrollRejectReason: null });
    expect((await get(s1.id)).payrollReference).not.toBeNull();
  });

  test("statements refused earlier stay out of the poll; nothing was paid twice", async () => {
    expect(await get(st.b)).toMatchObject({ paidAt: null, payrollReference: null });
    expect(await pollPayrollStatus({ now: later(60), workspaceId: W })).toMatchObject({ rejected: 0, duplicate: 0 });
    const paidTwice = await prisma.auditEvent.findMany({ where: { workspaceId: W, action: "partner_event", summary: { contains: "paid by payroll" } }, select: { summary: true } });
    const numbers = paidTwice.flatMap((p) => p.summary.match(/ST-PP-\d+/g) ?? []);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});
