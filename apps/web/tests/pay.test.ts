import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { describePay } from "../src/lib/audit-diff";
import { PAY_KIND_LABEL, payLabel } from "../src/lib/desk-format";
import { PAY_KINDS, validateDriver } from "../src/lib/fleet-forms";
import { PERCENT_MAX, percentOf, percentText, rateConTotal } from "../src/lib/pay";
import { driverFacingPay, payEstimate } from "../src/server/tl/projector";

describe("a percent of the rate confirmation", () => {
  it("is taken of the agreed rate plus its fuel surcharge, to the cent", () => {
    expect(rateConTotal(1000, 150)).toBe(1150);
    expect(rateConTotal(1000, null)).toBe(1000);
    expect(rateConTotal(null, undefined)).toBe(0);
    expect(rateConTotal(1234.56, 0.04)).toBe(1234.6);
    expect(percentOf(25, 1150)).toBe(287.5);
    expect(percentOf(30, 1000)).toBe(300);
    expect(percentOf(12.5, 801)).toBe(100.13); // 100.125 rounds up
  });

  it("rounds exactly as the database does, across a few thousand cases", () => {
    let seed = 7;
    const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let i = 0; i < 4000; i++) {
      const percent = Math.round(next() * 9999) / 100; // 0.00 to 99.99
      const base = Math.round(next() * 500000) / 100; // $0.00 to $5,000.00
      const exact = new Prisma.Decimal(percent).times(base).div(100).toDecimalPlaces(2).toNumber();
      expect(percentOf(percent, base)).toBe(exact);
    }
  });

  it("reads as people say it", () => {
    expect(percentText(25)).toBe("25% of the rate");
    expect(percentText(27.5)).toBe("27.5% of the rate");
    expect(percentText(33.333)).toBe("33.33% of the rate");
    expect(describePay("percent", 25)).toBe("25% of the rate");
    expect(payLabel("percent", 12.5)).toBe("12.5% of the rate");
    expect(PAY_KIND_LABEL.percent).toBe("Percent of the rate");
    expect(PAY_KIND_LABEL.flat).toBe("Set amount");
  });
});

describe("the pay estimate", () => {
  it("is the share of the rate confirmation's total for a percent, and still the contract's sums for the rest", () => {
    expect(payEstimate({ kind: "percent", rate: 25 }, 300, null, 1150)).toBe(287.5);
    expect(payEstimate({ kind: "flat", rate: 450 }, 300, null, 1150)).toBe(450);
    expect(payEstimate({ kind: "cpm", rate: 0.5 }, 245, null, 1150)).toBe(122.5);
    expect(payEstimate({ kind: "hourly", rate: 24 }, 245, 8.5, 1150)).toBe(204);
  });

  it("refuses to guess a percent without the rate, rather than call it zero", () => {
    expect(() => payEstimate({ kind: "percent", rate: 25 }, 300, null)).toThrow(/needs the rate confirmation's total/);
  });

  it("is told to the driver as the set amount it comes to, never as a percent of a rate they are not shown", () => {
    expect(driverFacingPay({ kind: "percent", rate: 25 }, 1150)).toEqual({ kind: "flat", rate: 287.5 });
    expect(driverFacingPay({ kind: "cpm", rate: 0.5 }, 1150)).toEqual({ kind: "cpm", rate: 0.5 });
    expect(driverFacingPay({ kind: "flat", rate: 450 }, 1150)).toEqual({ kind: "flat", rate: 450 });
  });
});

describe("a driver's usual pay", () => {
  it("can be a set amount or a percent of the rate", () => {
    expect(PAY_KINDS.map((k) => k.key)).toEqual(["cpm", "hourly", "flat", "percent"]);
    const pct = validateDriver({ name: "Alex Rivera", payKind: "percent", payRate: "27.5" });
    expect(pct.ok && pct.payRate).toBe(27.5);
    const flat = validateDriver({ name: "Alex Rivera", payKind: "flat", payRate: "450" });
    expect(flat.ok && flat.payRate).toBe(450);
  });

  it("a percent is more than nothing and less than all of the rate", () => {
    for (const bad of ["0", "-5", "100", "150", "abc", ""]) {
      const out = validateDriver({ name: "Alex Rivera", payKind: "percent", payRate: bad });
      expect(out.ok, bad).toBe(false);
      if (!out.ok) expect(out.errors.payRate).toBeDefined();
    }
    expect(validateDriver({ name: "Alex Rivera", payKind: "percent", payRate: String(PERCENT_MAX) }).ok).toBe(true);
  });

  it("an unknown kind is refused with all four named", () => {
    const out = validateDriver({ name: "Alex Rivera", payKind: "barter", payRate: "5" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.payKind).toMatch(/percent of the rate/);
  });
});
