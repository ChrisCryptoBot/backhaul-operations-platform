import { describe, expect, test } from "vitest";
import { gustoEventToNeutral, normalizeGustoRun, SANDBOX_CLEAR_HOURS, SANDBOX_REJECT_PREFIX, sandboxGustoClient, sandboxPayrollEvent } from "../src/server/partners/adapters/gusto";
import { PAYROLL_POLL_AFTER_DAYS } from "../src/server/partners/payroll";
import { readNeutralEvent } from "../src/server/partners/webhook-core";

/**
 * The payroll status poll's pure parts (docs/MONEY_PLAN.md, Wave 4 step 5): the simulator's runs (pending, paid after they clear, a worker refused), the run report into the desk's answer, and a
 * refusal arriving by webhook in the company's shape and in the neutral one.
 */
const SENT = "2026-11-01T12:00:00.000Z";
const at = (h: number) => new Date(new Date(SENT).getTime() + h * 3_600_000).toISOString();
const ask = (asOf: string, workers: Array<string | null>) =>
  sandboxGustoClient.getRun({ run_id: "GUS-SBX-1", context: { sent_at: SENT, as_of: asOf, payments: workers.map((w, i) => ({ idempotency_key: `statement:s${i}`, worker_id: w })) } });

describe("the simulator's runs", () => {
  test("it clears after the poll starts asking, so the poll meets both pending and cleared runs", () => {
    expect(SANDBOX_CLEAR_HOURS).toBeGreaterThan(PAYROLL_POLL_AFTER_DAYS * 24);
  });

  test("pending until it clears, then paid on the hour it cleared", async () => {
    const before = normalizeGustoRun(await ask(at(SANDBOX_CLEAR_HOURS - 1), ["w-1", "w-2"]));
    expect(before).toMatchObject({ ok: true, data: { state: "pending", paidAt: null } });
    const after = normalizeGustoRun(await ask(at(SANDBOX_CLEAR_HOURS + 5), ["w-1", "w-2"]));
    expect(after).toMatchObject({ ok: true, data: { reference: "GUS-SBX-1", state: "paid", paidAt: at(SANDBOX_CLEAR_HOURS), payments: [{ id: "s0", status: "paid" }, { id: "s1", status: "paid" }] } });
    // The same question answers the same.
    expect(normalizeGustoRun(await ask(at(SANDBOX_CLEAR_HOURS + 5), ["w-1", "w-2"]))).toEqual(after);
  });

  test("a refused worker is rejected with a reason whatever the clock; some refused is mixed, all refused is rejected", async () => {
    const mixed = normalizeGustoRun(await ask(at(1), ["w-1", `${SANDBOX_REJECT_PREFIX}9`]));
    expect(mixed).toMatchObject({ ok: true, data: { state: "mixed", payments: [{ id: "s0", status: "pending" }, { id: "s1", status: "rejected", reason: "The worker's bank account could not be verified." }] } });
    expect(normalizeGustoRun(await ask(at(200), [`${SANDBOX_REJECT_PREFIX}9`]))).toMatchObject({ ok: true, data: { state: "rejected" } });
    expect(normalizeGustoRun(await ask(at(200), ["w-1", `${SANDBOX_REJECT_PREFIX}9`]))).toMatchObject({ ok: true, data: { state: "mixed", payments: [{ status: "paid" }, { status: "rejected" }] } });
  });
});

describe("a refusal by webhook", () => {
  test("the company's shape names the statement by the desk's key, with the reason", () => {
    const e = sandboxPayrollEvent({ kind: "payroll.rejected", runId: "GUS-SBX-1", id: "evt_r1", secret: "x", statementId: "st_42", reason: "Closed account." });
    expect(gustoEventToNeutral(JSON.parse(e.raw))).toEqual({ id: "evt_r1", kind: "payroll.rejected", reference: "GUS-SBX-1", referenceId: "st_42", stop: null, detail: "Closed account." });
    // A paid event carries no statement and no reason.
    const paid = gustoEventToNeutral(JSON.parse(sandboxPayrollEvent({ kind: "payroll.paid", runId: "GUS-SBX-1", id: "evt_p1", secret: "x" }).raw));
    expect(paid).toMatchObject({ kind: "payroll.paid", referenceId: null });
    expect(paid).not.toHaveProperty("detail");
  });

  test("the neutral envelope reads it too", () => {
    const raw = JSON.stringify({ id: "n1", type: "payroll.rejected", reference: "RUN-1", reference_id: "st_9", reason: "Bad routing number." });
    expect(readNeutralEvent(JSON.parse(raw), raw)).toEqual({ id: "n1", kind: "payroll.rejected", reference: "RUN-1", referenceId: "st_9", detail: "Bad routing number." });
  });
});
