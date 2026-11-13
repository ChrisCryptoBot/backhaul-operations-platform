import { describe, expect, test } from "vitest";
import { deductionLines, needsNegativeConfirm, NO_CHOICES, proposeAdvances, proposeDeductions, runsDuring, typedChoices, validateAdvance, validateDeduction, type AdvanceRecord, type DeductionLine, type DeductionRule } from "../src/lib/deductions";
import { classifyLine, tallyLines, toCents } from "../src/lib/form1099";
import { computeStatement, isNetPay, payNote, rowsTotalCents, statementRows, type SettlementLoad } from "../src/lib/settlement";

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
    expect(ok.lines).toEqual([{ deductionId: null, advanceId: null, kind: "escrow_release", label: "Escrow released", basis: "Lease ended", amount: 120.5 }]);
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
    expect(needsNegativeConfirm(-100, [{ deductionId: null, advanceId: null, kind: "escrow_release", label: "x", basis: null, amount: 50 }])).toBe(false);
    expect(needsNegativeConfirm(0, [{ deductionId: "a", advanceId: null, kind: "deduction", label: "x", basis: null, amount: -50 }])).toBe(false);
    const release = computeStatement({ loads: [], hours: {}, adjustments: [], deductions: [{ deductionId: null, advanceId: null, kind: "escrow_release", label: "Escrow released", basis: "Lease ended", amount: 300 }] });
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

describe("advances (step 4)", () => {
  const adv = (over: Partial<AdvanceRecord> = {}): AdvanceRecord => ({ id: "a1", amountCents: 50000, repayCents: 30000, givenOn: "2026-10-03", method: "cash", active: true, note: null, ...over });
  const owed = (c: number) => ({ takenByRule: {}, escrowHeldCents: 0, owedByAdvance: { a1: c } });

  test("a repayment is the set amount or what is left, never more than is owed", () => {
    expect(proposeAdvances([adv()], owed(50000), "2026-10-11").map((o) => [o.source, o.proposedCents, o.soFarCents, o.note])).toEqual([["advance", 30000, 50000, null]]);
    expect(proposeAdvances([adv()], owed(20000), "2026-10-11")[0]).toMatchObject({ proposedCents: 20000, note: "Only $200.00 left to repay." });
    expect(proposeAdvances([adv()], owed(0), "2026-10-11")).toEqual([]);
    expect(proposeAdvances([adv({ active: false })], owed(50000), "2026-10-11")).toEqual([]);
    expect(proposeAdvances([adv({ givenOn: "2026-10-12" })], owed(50000), "2026-10-11")).toEqual([]);
  });

  test("it becomes an advance_repaid line naming its advance, skippable with a reason, and counted by rule K", () => {
    const options = proposeAdvances([adv()], owed(50000), "2026-10-11");
    const { lines } = deductionLines(options, NO_CHOICES, 0);
    expect(lines).toEqual([{ deductionId: null, advanceId: "a1", kind: "advance_repaid", label: "Advance of $500.00, Oct 3, 2026 (cash)", basis: "Advance repaid", amount: -300 }]);
    expect(deductionLines(options, { skips: { a1: "Slow week" }, release: null }, 0).lines).toEqual([]);
    const st = computeStatement({ loads: [], hours: {}, adjustments: [{ label: "Detention", amount: "100" }], deductions: lines });
    expect(st).toMatchObject({ total: -200, needsConfirm: true });
    expect(statementRows(st).find((r) => r.kind === "advance_repaid")).toMatchObject({ advanceId: "a1", amount: -300, sort: 30000 });
  });

  test("recording one: a real day not ahead of today, repaid no faster than the advance", () => {
    expect(validateAdvance({ amount: "500", givenOn: "2026-10-03", method: "cash", repay: "100" }, "2026-11-12")).toMatchObject({ ok: true, amountCents: 50000, repayCents: 10000 });
    expect(validateAdvance({ amount: "500", givenOn: "2026-11-13", method: "cash", repay: "100" }, "2026-11-12")).toMatchObject({ ok: false, errors: { givenOn: "That day has not come yet." } });
    expect(validateAdvance({ amount: "500", givenOn: "2026-10-03", method: "cash", repay: "600" }, "2026-11-12")).toMatchObject({ ok: false, errors: { repay: "No more than the advance." } });
    expect(validateAdvance({ amount: "500", givenOn: "2026-10-03", method: "venmo", repay: "100" }, "2026-11-12").ok).toBe(false);
  });

  test("the 1099 counts the advance and its repayment as pass-through: net only, never gross, never unknown", () => {
    expect(classifyLine("advance_repaid", -300)).toBe("pass");
    expect(classifyLine("advance", 500)).toBe("pass");
    const t = tallyLines([{ kind: "load", cents: 40000 }, { kind: "advance_repaid", cents: -30000 }]);
    expect(t).toMatchObject({ grossCents: 40000, netCents: 10000, passCents: -30000, unknownKinds: [] });
  });

  test("the footnote names only what is on the statement: no fuel but a repayment is still net pay", () => {
    const line = (kind: DeductionLine["kind"], amount: number): DeductionLine => ({ deductionId: null, advanceId: null, kind, label: kind, basis: null, amount });
    expect(payNote({ fuel: [], deductions: [] })).toBe("Gross pay for the loads and adjustments above.");
    expect(isNetPay({ fuel: [], deductions: [line("advance_repaid", -1)] })).toBe(true);
    expect(payNote({ fuel: [], deductions: [line("advance_repaid", -1)] })).toBe("Net pay: pay for the loads, plus the adjustments, less the advance repaid above.");
    expect(payNote({ fuel: [], deductions: [line("escrow", -1), line("escrow_release", 1)] })).toBe("Net pay: pay for the loads, plus the adjustments, less the deductions and escrow held, plus the escrow released above.");
  });
});
