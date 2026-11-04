import { describe, expect, it } from "vitest";
import { parseBrokerSnippet } from "@/lib/quote-parser";

describe("parseBrokerSnippet", () => {
  it("extracts full load details from a typical broker snippet", () => {
    const raw = "Dallas, TX to Atlanta, GA. 42k lbs dry van paying $1,850 all-in. MC# 123456 PO: PO-9988 Load: LD-4411";
    const res = parseBrokerSnippet(raw);
    expect(res.origin).toBe("Dallas, TX");
    expect(res.destination).toBe("Atlanta, GA");
    expect(res.weightLbs).toBe("42000");
    expect(res.trailer).toBe("dry_van");
    expect(res.offer).toBe("1850");
    expect(res.brokerMc).toBe("123456");
    expect(res.poNumber).toBe("PO-9988");
    expect(res.loadNumber).toBe("LD-4411");
  });

  it("handles arrows and reefer equipment", () => {
    const raw = "Chicago, IL -> Indianapolis, IN | 38,500 lbs Reefer | Rate: $650";
    const res = parseBrokerSnippet(raw);
    expect(res.origin).toBe("Chicago, IL");
    expect(res.destination).toBe("Indianapolis, IN");
    expect(res.weightLbs).toBe("38500");
    expect(res.trailer).toBe("reefer");
    expect(res.offer).toBe("650");
  });

  it("handles flatbed and plain rate", () => {
    const raw = "Houston, TX to Memphis, TN 45000# flatbed $2400";
    const res = parseBrokerSnippet(raw);
    expect(res.origin).toBe("Houston, TX");
    expect(res.destination).toBe("Memphis, TN");
    expect(res.weightLbs).toBe("45000");
    expect(res.trailer).toBe("flatbed");
    expect(res.offer).toBe("2400");
  });

  it("gracefully handles empty or partial inputs", () => {
    expect(parseBrokerSnippet("")).toEqual({});
    expect(parseBrokerSnippet("Just chatting with a broker")).toEqual({});
  });
});
