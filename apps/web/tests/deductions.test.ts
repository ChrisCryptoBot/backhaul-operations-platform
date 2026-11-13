import { describe, expect, test } from "vitest";
import { deductionLines, needsNegativeConfirm, proposeDeductions, runsDuring, typedChoices, validateDeduction, type DeductionRule } from "../src/lib/deductions";
import { classifyLine, tallyLines, toCents } from "../src/lib/form1099";
import { computeStatement, rowsTotalCents, statementRows, type SettlementLoad } from "../src/lib/settlement";

/**
 * Recurring deductions and escrow (docs/MONEY_PLAN.md, Wave 4 step 3, rule K): what a draft is offered, escrow stopping at its goal, a cap, a skip with its reason, a release no larger than
 * what is held, the below-zero confirmation, the rows adding up to the total, and how the 1099 counts each new kind.
 */
const rule = (over: Partial<DeductionRule> & Pick<DeductionRule, "id" | "kind">): DeductionRule => ({ label: over.id, amountCents: 10000, goalCents: null, startsOn: null, endsOn: null, active: true, ...over });
const none = { takenByRule: {}, escrowHeldCents: 0 };
const W = ["2026-10-05", "2026-10-11"] as const;

describe("what a draft is offered", () => {
  test("escrow builds to its goal, then stops; two escrow rules share one pool", () => {
    const rules = [rule({ id: "esc", kind: "escrow", amountCents: 20000, goalCents: 30000 }), rule({ id: "esc2", kind: "escrow", amountCents: 20000, goalCents: 30000 })];
    expect(proposeDeductions(rules, none, ...W).map((o) => o.proposedCents)).toEqual([20000, 10000]);
    const half = proposeDeductions(rules.slice(0, 1), { takenByRule: {}, escrowHeldCents: 25000 }, ...W)[0]!;
    expect(half.proposedCents).toBe(5000);
    expect(half.note).toContain("to reach the $300.00 goal");
    const full = proposeDeductions(rules.slice(0, 1), { takenByRule: {}, escrowHeldCents: 30000 }, ...W)[0]!;
    expect(full.proposedCents).toBe(0);
    expect(full.note).toContain("reached its $300.00 goal");
  });

  test("a cap stops a deduction once it has taken that much in all", () => {
    const r = [rule({ id: "ins", kind: "insurance", amountCents: 10000, goalCents: 15000 })];
    expect(proposeDeductions(r, none, ...W)[0]!.proposedCents).toBe(10000);
    expect(proposeDeductions(r, { takenByRule: { ins: 10000 }, escrowHeldCents: 0 }, ...W)[0]!.proposedCents).toBe(5000);
    expect(proposeDeductions(r, { takenByRule: { ins: 15000 }, escrowHeldCents: 0 }, ...W)[0]!.proposedCents).toBe(0);
  });

  test("only active rules that run during the period", () => {
    expect(runsDuring({ active: true, startsOn: "2026-10-11", endsOn: null }, ...W)).toBe(true);
    expect(runsDuring({ active: true, startsOn: "2026-10-12", endsOn: null }, ...W)).toBe(false);
    expect(runsDuring({ active: true, startsOn: null, endsOn: "2026-10-04" }, ...W)).toBe(false);
    expect(runsDuring({ active: false, startsOn: null, endsOn: null }, ...W)).toBe(false);
  });
});

describe("the draft's choices", () => {
  const options = proposeDeductions([rule({ id: "lease", kind: "lease", amountCents: 30000 }), rule({ id: "esc", kind: "escrow", amountCents: 20000, goalCents: 50000 })], none, ...W);

  test("each offered rule is a negative line; escrow is its own kind", () => {
    const { lines, errors } = deductionLines(options, { skips: {}, release: null }, 0);
    expect(errors).toEqual({});
    expect(lines.map((l) => [l.kind, l.amount, l.deductionId])).toEqual([["deduction", -300, "lease"], ["escrow", -200, "esc"]]);
  });

  test("a skip needs a reason; with one, the line is left off", () => {
    expect(deductionLines(options, { skips: { lease: " " }, release: null }, 0).errors).toEqual({ "skip.lease": "Say why it is skipped this time." });
    expect(deductionLines(options, { skips: { lease: "Short week" }, release: null }, 0).lines.map((l) => l.deductionId)).toEqual(["esc"]);
  });

  test("a release is never more than what is held, and needs a reason", () => {
    expect(deductionLines([], { skips: {}, release: { amount: "500", reason: "Lease ended" } }, 30000).errors["release.amount"]).toBe("Only $300.00 is held in escrow.");
    expect(deductionLines([], { skips: {}, release: { amount: "100", reason: "" } }, 30000).errors["release.reason"]).toBeTruthy();
    const ok = deductionLines([], { skips: {}, release: { amount: "120.50", reason: "Lease ended" } }, 30000);
    expect(ok.lines).toEqual([{ deductionId: null, kind: "escrow_release", label: "Escrow released", basis: "Lease ended", amount: 120.5 }]);
    // An empty release box is no release at all.
    expect(deductionLines([], { skips: {}, release: { amount: "", reason: "" } }, 30000)).toEqual({ lines: [], errors: {} });
  });

  test("stored choices are read safely", () => {
    expect(typedChoices(null)).toEqual({ skips: {}, release: null });
    expect(typedChoices({ skips: { a: "x", b: 3 }, release: { amount: "5", reason: "r" } })).toEqual({ skips: { a: "x" }, release: { amount: "5", reason: "r" } });
  });
});

describe("the statement with deductions (rule K)", () => {
  const load: SettlementLoad = { loadId: "l1", loadNumber: "L-1", origin: "Dallas, TX", destination: "Austin, TX", deliveredAt: "2026-10-06T12:00:00Z", loadedMiles: 800, payKind: "cpm", payRate: 0.5, rateConTotal: 2000, assignedHours: null, brokerStatus: "paid" };

  test("the deductions come off the total, and the rows add up to it to the cent", () => {
    const { lines } = deductionLines(proposeDeductions([rule({ id: "lease", kind: "lease", amountCents: 30000 }), rule({ id: "esc", kind: "escrow", amountCents: 20033, goalCents: 90000 })], none, ...W), { skips: {}, release: null }, 0);
    const st = computeStatement({ loads: [load], hours: {}, adjustments: [{ label: "Bonus", amount: "25" }], deductions: lines });
    expect(st).toMatchObject({ loadsTotal: 400, deductionsTotal: -500.33, total: -75.33, needsConfirm: true });
    expect(st.cautions[0]).toContain("below zero");
    const rows = statementRows(st);
    expect(rows.filter((r) => r.kind === "deduction" || r.kind === "escrow").map((r) => [r.kind, r.amount, r.deductionId, r.sort])).toEqual([["deduction", -300, "lease", 30000], ["escrow", -200.33, "esc", 30001]]);
    expect(rowsTotalCents(rows)).toBe(-7533);
  });

  test("below zero from fuel alone is not a deduction's doing; a release can make a statement payable", () => {
    expect(needsNegativeConfirm(-100, [])).toBe(false);
    expect(needsNegativeConfirm(-100, [{ deductionId: null, kind: "escrow_release", label: "x", basis: null, amount: 50 }])).toBe(false);
    expect(needsNegativeConfirm(0, [{ deductionId: "a", kind: "deduction", label: "x", basis: null, amount: -50 }])).toBe(false);
    const release = computeStatement({ loads: [], hours: {}, adjustments: [], deductions: [{ deductionId: null, kind: "escrow_release", label: "Escrow released", basis: "Lease ended", amount: 300 }] });
    expect(release.blockers).toEqual([]);
    expect(release.total).toBe(300);
  });
});

describe("setting a rule up", () => {
  test("escrow needs a goal; a cap cannot be under one statement; dates in order", () => {
    expect(validateDeduction({ kind: "escrow", label: "Escrow", amount: "200" })).toMatchObject({ ok: false, errors: { goal: expect.stringContaining("goal") } });
    expect(validateDeduction({ kind: "escrow", label: "Escrow", amount: "200", goal: "2500" })).toMatchObject({ ok: true, amountCents: 20000, goalCents: 250000 });
    expect(validateDeduction({ kind: "insurance", label: "Occ acc", amount: "200", goal: "100" }).ok).toBe(false);
    expect(validateDeduction({ kind: "lease", label: "Lease", amount: "-5" }).ok).toBe(false);
    expect(validateDeduction({ kind: "lease", label: "Lease", amount: "300", startsOn: "2026-11-01", endsOn: "2026-10-01" }).ok).toBe(false);
    expect(validateDeduction({ kind: "rent", label: "Lease", amount: "300" }).ok).toBe(false);
  });
});

describe("the 1099 counts the new kinds once", () => {
  test("deductions and escrow held are money off; an escrow release is pass-through: in net only, never gross, never unknown", () => {
    expect(classifyLine("deduction", -100)).toBe("off");
    expect(classifyLine("escrow", -100)).toBe("off");
    expect(classifyLine("escrow_release", 100)).toBe("pass");
    const t = tallyLines(["load:1000", "escrow:-200", "deduction:-300", "escrow_release:150"].map((x) => ({ kind: x.split(":")[0]!, cents: toCents(x.split(":")[1]!)! })));
    expect(t).toMatchObject({ grossCents: 100000, netCents: 65000, offCents: -50000, passCents: 15000, unknownKinds: [] });
  });
});
