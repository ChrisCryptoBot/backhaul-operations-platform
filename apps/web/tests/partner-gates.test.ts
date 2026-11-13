import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { CAPABILITIES } from "@/truelane/partners/contract";
import { FEATURES, FEATURE_PLAN, MONEY_MOVING, allowed, counselApproved, featureRefusal, moneyMovingVerdict, movesMoney, switchReason } from "@/lib/partner-gates";
import { PLAN_KEYS, effectivePlan } from "@/lib/plans";

/** Money plan Wave 7 step 1: plan gating of partner features and the money-moving switch (Gap 14), pure. The database half is tests/integration/money-moving.integration.test.ts. */
const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", "src", p), "utf8");

describe("plan gating", () => {
  test("every contract capability and both surface features have a row, and nothing else does", () => {
    for (const c of CAPABILITIES) expect(FEATURES, c).toContain(c);
    expect(Object.keys(FEATURE_PLAN).sort()).toEqual([...FEATURES].sort());
    for (const p of Object.values(FEATURE_PLAN)) expect(PLAN_KEYS).toContain(p);
  });

  test("D1: every company kind on every plan; the read API and outbound webhooks from Pro", () => {
    for (const c of CAPABILITIES) for (const p of PLAN_KEYS) expect(allowed(c, p), `${c} on ${p}`).toBe(true);
    for (const f of ["read_api", "outbound_webhooks"] as const) {
      expect(PLAN_KEYS.map((p) => allowed(f, p))).toEqual([false, false, true, true]);
    }
  });

  test("a refusal names the feature, the plan it needs and the plan the fleet is on; an unknown plan is Starter", () => {
    expect(featureRefusal("read_api", "growth")).toBe("The read API comes with the Pro plan and up; this fleet is on Growth. Talk to a person to change the plan.");
    expect(featureRefusal("read_api", "pro")).toBeNull();
    expect(featureRefusal("outbound_webhooks", effectivePlan("platinum"))).toContain("on Starter");
    expect(featureRefusal("outbound_webhooks", effectivePlan(null))).toContain("on Starter");
  });
});

describe("the money-moving switch", () => {
  test("only factoring and payroll move money, and payroll's status check does not", () => {
    expect(MONEY_MOVING).toEqual(["factoring", "payroll"]);
    expect(movesMoney("factoring", {})).toBe(true);
    expect(movesMoney("payroll", { statements: [] })).toBe(true);
    expect(movesMoney("payroll", { op: "send", statements: [] })).toBe(true);
    expect(movesMoney("payroll", { op: "status", reference: "x" })).toBe(false);
    for (const c of CAPABILITIES.filter((c) => c !== "factoring" && c !== "payroll")) expect(movesMoney(c, {}), c).toBe(false);
  });

  test("counsel's sign-off is the word yes and nothing else", () => {
    expect(counselApproved({ MONEY_MOVING_COUNSEL_APPROVED: "yes" })).toBe(true);
    expect(counselApproved({ MONEY_MOVING_COUNSEL_APPROVED: " YES " })).toBe(true);
    for (const v of [undefined, "", "true", "1", "on", "y"]) expect(counselApproved({ MONEY_MOVING_COUNSEL_APPROVED: v }), String(v)).toBe(false);
  });

  test("a live money-moving call needs both; the simulator, a refused key and every other kind never ask", () => {
    const v = (capability: string, mode: "live" | "sandbox" | "refused", counsel: boolean, workspaceLive: boolean) => moneyMovingVerdict({ capability, mode, counsel, workspaceLive });
    expect(v("factoring", "live", false, false)).toMatchObject({ ok: false, reason: "counsel" });
    expect(v("factoring", "live", false, true)).toMatchObject({ ok: false, reason: "counsel" });
    expect(v("payroll", "live", true, false)).toMatchObject({ ok: false, reason: "workspace", message: expect.stringContaining("Sending pay runs to payroll") });
    expect(v("factoring", "live", true, true)).toEqual({ ok: true });
    expect(v("factoring", "sandbox", false, false)).toEqual({ ok: true });
    expect(v("payroll", "refused", false, false)).toEqual({ ok: true }); // a sandbox_ key off the demo desk is refused by keyMode's own message
    expect(v("eld", "live", false, false)).toEqual({ ok: true });
    for (const m of ["counsel", "workspace"] as const) {
      const out = m === "counsel" ? v("factoring", "live", false, false) : v("factoring", "live", true, false);
      if (out.ok) throw new Error("expected a refusal");
      expect(out.message).toContain("Nothing was sent.");
    }
  });

  test("a reason says something; spaces are folded and it is cut at 300", () => {
    expect(switchReason("  short ")).toMatchObject({ ok: false });
    expect(switchReason(undefined)).toMatchObject({ ok: false });
    expect(switchReason("Counsel   memo\n2026-11")).toEqual({ ok: true, reason: "Counsel memo 2026-11" });
    const long = switchReason("x".repeat(400));
    expect(long.ok && long.reason.length).toBe(300);
  });

  test("every path that could move money asks before it claims or calls", () => {
    const factoring = src("server/partners/factoring.ts");
    const fi = factoring.slice(factoring.indexOf("export async function factorInvoice"));
    expect(fi.indexOf('checkMoneyMoving("factoring"')).toBeGreaterThan(0);
    expect(fi.indexOf('checkMoneyMoving("factoring"')).toBeLessThan(fi.indexOf("const claimed ="));

    const payroll = src("server/partners/payroll.ts");
    const sp = payroll.slice(payroll.indexOf("export async function sendToPayroll"));
    expect(sp.indexOf('checkMoneyMoving("payroll"')).toBeGreaterThan(0);
    expect(sp.indexOf('checkMoneyMoving("payroll"')).toBeLessThan(sp.indexOf("const claimed ="));

    const batch = src("server/partners/factoring-batch.ts");
    const tf = batch.slice(batch.indexOf("async function transportFor"));
    expect(tf.indexOf('assertMoneyMovingAllowed("factoring"')).toBeGreaterThan(0);
    expect(tf.indexOf('assertMoneyMovingAllowed("factoring"')).toBeLessThan(tf.indexOf("liveBatchTransport.deliver"));

    const call = src("server/partners/call.ts");
    const cp = call.slice(call.indexOf("export async function callPartner"));
    expect(cp.indexOf("movesMoney(capability, input)")).toBeGreaterThan(0);
    expect(cp.indexOf("movesMoney(capability, input)")).toBeLessThan(cp.indexOf("partnerAdapters[capability]"));
  });

  test("the switch's server half takes the workspace explicitly, never the request's default", () => {
    const gates = src("server/partners/gates.ts");
    expect(gates).not.toContain("currentWorkspaceId");
    expect(gates).not.toMatch(/workspaceId\s*=\s*/);
  });
});
