import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { carrierIndicators } from "@/lib/carrier-status";
import { statementPayBadge } from "@/lib/statement-pay";
import { paidMethodLabel } from "@/lib/pay-method";

const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");
const NOW = new Date("2026-12-02T15:00:00Z");

describe("the carrier check's tags", () => {
  const read = (c: Partial<Parameters<typeof carrierIndicators>[0]>) => carrierIndicators({ coiExpiresAt: null, safetyScore: null, authorityActive: null, ...c }, NOW).map((i) => `${i.key}:${i.tone}:${i.text}`);

  it("says nothing for a carrier that has not been checked", () => {
    expect(read({})).toEqual([]);
  });

  it("authority is a plain yes or no, never a guess when the check did not say", () => {
    expect(read({ authorityActive: true })).toEqual(["authority:ok:Authority active"]);
    expect(read({ authorityActive: false })).toEqual(["authority:bad:Authority not active"]);
  });

  it("the safety score is red under 60, amber under 75, and green from there", () => {
    expect(read({ safetyScore: 48 })).toEqual(["safety:bad:Safety 48"]);
    expect(read({ safetyScore: 60 })).toEqual(["safety:warn:Safety 60"]);
    expect(read({ safetyScore: 74 })).toEqual(["safety:warn:Safety 74"]);
    expect(read({ safetyScore: 75 })).toEqual(["safety:ok:Safety 75"]);
  });

  it("insurance is good through the whole day it names, amber inside thirty days, red once it has lapsed", () => {
    expect(read({ coiExpiresAt: new Date("2027-06-01") })).toEqual(["insurance:ok:Insured to Jun 1, 2027"]);
    expect(read({ coiExpiresAt: new Date("2026-12-14") })).toEqual(["insurance:warn:Insurance lapses in 13 days"]);
    expect(read({ coiExpiresAt: new Date("2027-01-01") })).toEqual(["insurance:ok:Insured to Jan 1, 2027"]); // 31 days out is past the thirty-day warning
    expect(read({ coiExpiresAt: new Date("2026-12-02") })).toEqual(["insurance:warn:Insurance lapses in 1 day"]); // good through tonight
    expect(read({ coiExpiresAt: new Date("2026-12-01") })).toEqual(["insurance:bad:Insurance lapsed Dec 1, 2026"]);
    expect(read({ coiExpiresAt: "2026-12-14" })).toEqual(["insurance:warn:Insurance lapses in 13 days"]);
    expect(read({ coiExpiresAt: "not a date" })).toEqual([]);
  });

  it("all three together, in a fixed order", () => {
    expect(read({ authorityActive: true, safetyScore: 82, coiExpiresAt: new Date("2027-06-01") })).toEqual(["authority:ok:Authority active", "safety:ok:Safety 82", "insurance:ok:Insured to Jun 1, 2027"]);
  });
});

describe("a driver statement's pay badge", () => {
  const base = { paidAt: null, paidMethod: null, payrollSentAt: null, payrollReference: null };

  it("is nothing until the statement is paid or sent to payroll", () => {
    expect(statementPayBadge(base)).toBeNull();
  });

  it("with payroll and not cleared is amber and names the run", () => {
    expect(statementPayBadge({ ...base, payrollSentAt: new Date("2026-11-20"), payrollReference: "GUS-SBX-ABC" })).toEqual({ label: "With payroll", tone: "warn", detail: "sent Nov 20, 2026, run GUS-SBX-ABC, not cleared yet" });
  });

  it("paid by the payroll company is its own words, not a hand-marked payment", () => {
    expect(statementPayBadge({ ...base, paidAt: new Date("2026-11-25"), paidMethod: "payroll", payrollSentAt: new Date("2026-11-20"), payrollReference: "GUS-SBX-ABC" })).toEqual({ label: "Paid by payroll", tone: "ok", detail: "Nov 25, 2026, run GUS-SBX-ABC" });
    expect(statementPayBadge({ ...base, paidAt: new Date("2026-11-25"), paidMethod: "check" })).toEqual({ label: "Paid, Check", tone: "ok", detail: "Nov 25, 2026" });
    expect(statementPayBadge({ ...base, paidAt: new Date("2026-11-25") })).toMatchObject({ label: "Paid" });
  });

  it("'payroll' is a label for a statement, and still not a way to receive an invoice payment", () => {
    expect(paidMethodLabel("payroll")).toBe("Payroll");
    expect(paidMethodLabel("check")).toBe("Check");
    expect(paidMethodLabel("nonsense")).toBe("");
    expect(src("src/lib/pay-method.ts")).not.toMatch(/key: "payroll"/);
  });
});

describe("the screens are on the rail for the people who use them", () => {
  const shell = src("src/components/desk/desk-shell.tsx");

  it("Fuel is for dispatch and billing, IFTA is billing's, each with its two-letter code", () => {
    expect(shell).toMatch(/href: "\/fuel", label: "Fuel", code: "FU", roles: \["admin", "dispatcher", "accounting"\]/);
    expect(shell).toMatch(/href: "\/ifta", label: "IFTA", code: "IF", roles: \["admin", "accounting"\]/);
    expect(src("src/components/desk/ui.tsx")).toContain('Fuel: "FU", IFTA: "IF"');
  });

  it("the actions behind them ask the same roles", () => {
    const actions = src("src/app/(desk)/actions.ts");
    expect(actions).toMatch(/syncFuelCardsAction[\s\S]*?requireCan\("dispatch", "bill"\)/);
    expect(actions).toMatch(/calculateIftaAction[\s\S]*?requireCan\("bill"\)/);
    expect(actions).toMatch(/shareLocationAction[\s\S]*?requireCan\("dispatch"\)/);
  });

  it("the load page offers tracking, the drivers page shows the carrier tags, and the payroll and statement screens use the badge", () => {
    expect(src("src/components/desk/load-view.tsx")).toContain("<TrackingPanel");
    expect(src("src/app/(desk)/drivers/page.tsx")).toContain("<CarrierStatus");
    expect(src("src/app/(desk)/settlements/page.tsx")).toContain("statementPayBadge");
    expect(src("src/app/(desk)/payroll/page.tsx")).toContain("Paid by payroll");
  });

  it("a share needs the carrier's yes in the same call, and the panel keeps the button off until it is ticked", () => {
    expect(src("src/components/desk/tracking-panel.tsx")).toContain("!agree");
    expect(src("src/server/partners/tracking.ts")).toContain("needs the carrier's yes for this load");
  });
});
