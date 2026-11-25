import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { milesGapSummary, payKindsForArrangement, resolveIsContractor, resolvePayArrangement } from "../src/lib/pay-arrangement";

describe("pay arrangement precedence (Addendum P.1)", () => {
  it("uses explicit desk driverArrangement before phone link role or workspace default", () => {
    expect(resolvePayArrangement({ driverArrangement: "company", inviteRole: "owner_op_leased", workspaceDefault: "contractor" })).toBe("company");
    expect(resolveIsContractor({ driverArrangement: "company", inviteRole: "owner_op_leased", workspaceDefault: "contractor" })).toBe(false);

    expect(resolvePayArrangement({ driverArrangement: "contractor", inviteRole: null, workspaceDefault: "company" })).toBe("contractor");
    expect(resolveIsContractor({ driverArrangement: "contractor", inviteRole: "company_employee", workspaceDefault: "company" })).toBe(true);
  });

  it("falls back to phone link role when desk arrangement is unset, then workspace default", () => {
    expect(resolvePayArrangement({ driverArrangement: null, inviteRole: "owner_op_leased", workspaceDefault: "company" })).toBe("contractor");
    expect(resolvePayArrangement({ driverArrangement: "", inviteRole: null, workspaceDefault: "contractor" })).toBe("contractor");
    expect(resolvePayArrangement({ driverArrangement: null, inviteRole: null, workspaceDefault: "company" })).toBe("company");
    expect(resolvePayArrangement({})).toBe("company");
  });

  it("offers company drivers per-mile/hourly only and contractors all pay kinds", () => {
    expect(payKindsForArrangement("company")).toEqual(["cpm", "hourly"]);
    expect(payKindsForArrangement("contractor")).toEqual(["percent", "flat", "cpm", "hourly"]);
  });
});

describe("logged vs billable miles gap (Addendum P.2)", () => {
  it("never caps logged miles to billable loaded miles and formats reroute delta", () => {
    const loggedBasis = milesGapSummary(642, 600, "logged");
    expect(loggedBasis.paidMiles).toBe(642);
    expect(loggedBasis.loggedMiles).toBe(642);
    expect(loggedBasis.billableMiles).toBe(600);
    expect(loggedBasis.delta).toBe(42);
    expect(loggedBasis.label).toBe("logged 642 mi · billable 600 mi · +42 reroute");

    const billableBasis = milesGapSummary(642, 600, "billable");
    expect(billableBasis.paidMiles).toBe(600);
    expect(billableBasis.label).toBe("logged 642 mi · billable 600 mi · +42 reroute");
  });

  it("falls back to billable miles cleanly when logged miles are not recorded or equal", () => {
    expect(milesGapSummary(null, 600, "logged")).toEqual({ paidMiles: 600, loggedMiles: null, billableMiles: 600, delta: null, basis: "logged", label: null });
    expect(milesGapSummary(600, 600, "logged")).toEqual({ paidMiles: 600, loggedMiles: 600, billableMiles: 600, delta: 0, basis: "logged", label: null });
  });
});

describe("load drawer estimate labels (Addendum P.3)", () => {
  const drawer = readFileSync(path.join(__dirname, "..", "src", "components", "desk", "load-view.tsx"), "utf8");

  it("labels pre-settlement driver pay as estimate and notes company payroll independence", () => {
    expect(drawer).toContain("Driver pay (estimate)");
    expect(drawer).toContain("Estimate · company payroll (independent of load profit)");
  });

  it("removes outdated Phase 2 'not split yet' relay copy", () => {
    expect(drawer).not.toContain("not split yet");
  });
});
