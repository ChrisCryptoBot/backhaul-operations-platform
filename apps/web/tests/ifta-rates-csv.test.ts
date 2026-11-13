import { describe, expect, it } from "vitest";
import {
  autoIftaRateMap,
  checkIftaRateRows,
  cleanIftaRateMap,
  iftaRateTemplate,
  isIftaQuarter,
  missingIftaRateFields,
  readJurisdiction,
  readQuarter,
  readRate,
  sampleIftaRates,
  SAMPLE_JURISDICTIONS,
  type IftaRateCheckContext
} from "@/lib/ifta-rates-csv";
import { parseCsv } from "@/lib/import-csv";

const ctx = (over: Partial<IftaRateCheckContext> = {}): IftaRateCheckContext => ({ quarter: "2026-Q3", status: "provisional", ...over });
const run = (csv: string, over: Partial<IftaRateCheckContext> = {}) => {
  const table = parseCsv(csv);
  return checkIftaRateRows(table, autoIftaRateMap(table[0]!), ctx(over));
};
const byCode = (c: ReturnType<typeof run>) => Object.fromEntries(c.good.map((g) => [g.item.jurisdiction, g.item]));
const errorsOn = (c: ReturnType<typeof run>, line: number) => c.problems.find((p) => p.line === line)?.errors ?? [];

describe("IFTA rate file: reading cells (Wave 5 step 4)", () => {
  it("reads a rate as an exact 4-place decimal string, never a float", () => {
    expect(readRate("0.285")).toBe("0.2850");
    expect(readRate("$0.2850")).toBe("0.2850");
    expect(readRate(".3")).toBe("0.3000");
    expect(readRate("00.1")).toBe("0.1000");
    expect(readRate("0.285000")).toBe("0.2850");
    expect(readRate("0.1 ")).toBe("0.1000");
    // 0.0000 is a rate; blank is not one.
    expect(readRate("0")).toBe("0.0000");
    expect(readRate("0.0000")).toBe("0.0000");
    expect(readRate("")).toBeNull();
    expect(readRate("   ")).toBeNull();
  });

  it("refuses negative, split, over-precise, too-large and non-numeric cells with a reason", () => {
    for (const bad of ["-0.1", "(0.10)", "-$0.2"]) expect(readRate(bad)).toEqual({ error: expect.stringContaining("negative") });
    for (const split of ["0.285/0.31", "0.285 / 0.31", "0.285-0.31", "0.285 - 0.31", "0.285; 0.31", "0.285 0.31", "0.285 and 0.31"]) expect(readRate(split)).toEqual({ error: expect.stringContaining("two rates") });
    expect(readRate("0.28505")).toEqual({ error: expect.stringContaining("4 decimals") });
    expect(readRate("28.5")).toEqual({ error: expect.stringContaining("typo") });
    expect(readRate("abc")).toEqual({ error: "is not a number." });
    expect(readRate(".")).toEqual({ error: "is not a number." });
  });

  it("reads a quarter in the shapes files write it", () => {
    for (const q of ["2026-Q3", "2026 Q3", "2026Q3", "q3 2026", "Q3-2026", "3Q2026", "3Q 2026"]) expect(readQuarter(q)).toBe("2026-Q3");
    for (const q of ["2026-Q5", "Q3", "2026", "third quarter"]) expect(readQuarter(q)).toBeNull();
    expect(isIftaQuarter("2026-Q3")).toBe(true);
    for (const q of ["2026Q3", "2026-Q0", " 2026-Q3", 2026, null]) expect(isIftaQuarter(q)).toBe(false);
  });

  it("names the jurisdiction, a surcharge row, and a Canadian row", () => {
    expect(readJurisdiction("Texas")).toEqual({ code: "TX", surcharge: false, canada: false });
    expect(readJurisdiction("Kentucky Surcharge")).toEqual({ code: "KY", surcharge: true, canada: false });
    expect(readJurisdiction("KY - surcharge")).toEqual({ code: "KY", surcharge: true, canada: false });
    expect(readJurisdiction("Virginia (Surcharge)")).toEqual({ code: "VA", surcharge: true, canada: false });
    expect(readJurisdiction("District of Columbia")).toEqual({ code: "DC", surcharge: false, canada: false });
    expect(readJurisdiction("Ontario")).toEqual({ code: "ON", surcharge: false, canada: true });
    expect(readJurisdiction("Rates effective July 1")).toEqual({ code: null, surcharge: false, canada: false });
  });
});

describe("IFTA rate file: checking a file", () => {
  it("matches the IFTA-Inc-shaped header and the template, and names what is still needed", () => {
    expect(autoIftaRateMap(["Jurisdiction", "Diesel", "Gasoline", "Surcharge"])).toMatchObject({ jurisdiction: 0, rate: 1, surcharge: 3, quarter: null, status: null });
    expect(missingIftaRateFields(autoIftaRateMap(["State", "Gasoline"])).map((m) => m.key)).toEqual(["rate"]);
    expect(missingIftaRateFields(autoIftaRateMap(parseCsv(iftaRateTemplate())[0]!))).toEqual([]);
    expect(cleanIftaRateMap({ jurisdiction: 0, rate: 0, surcharge: 7 }, 3)).toMatchObject({ jurisdiction: 0, rate: null, surcharge: null });
  });

  it("keeps US rows (DC too), skips Canadian rows with a count, and keeps rate and surcharge apart", () => {
    const c = run(["Jurisdiction,Diesel,Surcharge", "Texas,0.20,", "DC,0.235,", "Ontario,0.143,", "Quebec,,", "Indiana,0.55,0.12", "Alaska,0.0000,"].join("\n"));
    expect(c).toMatchObject({ total: 6, canada: 2, problemCount: 0, duplicates: 0 });
    expect(byCode(c)).toEqual({
      AK: { jurisdiction: "AK", rate: "0.0000", surcharge: "0.0000", status: "provisional", surchargeLine: null },
      DC: { jurisdiction: "DC", rate: "0.2350", surcharge: "0.0000", status: "provisional", surchargeLine: null },
      IN: { jurisdiction: "IN", rate: "0.5500", surcharge: "0.1200", status: "provisional", surchargeLine: 6 },
      TX: { jurisdiction: "TX", rate: "0.2000", surcharge: "0.0000", status: "provisional", surchargeLine: null }
    });
    expect(c.good.map((g) => g.item.jurisdiction)).toEqual(["AK", "DC", "IN", "TX"]);
    expect(c.summary).toEqual({ jurisdictions: 4, withSurcharge: 1, final: 0, provisional: 4 });
    expect(c.missing).toHaveLength(51 - 4);
    expect(c.missing).not.toContain("TX");
  });

  it("folds a surcharge row into its state, whether the number sits in Rate or in Surcharge", () => {
    const c = run(["Jurisdiction,Rate,Surcharge", "Kentucky,0.246,", "Kentucky Surcharge,0.102,", "Virginia,0.31,0", "Virginia Surcharge,,0.143"].join("\n"));
    expect(c).toMatchObject({ problemCount: 0, duplicates: 0 });
    expect(byCode(c).KY).toMatchObject({ rate: "0.2460", surcharge: "0.1020", surchargeLine: 3 });
    expect(byCode(c).VA).toMatchObject({ rate: "0.3100", surcharge: "0.1430", surchargeLine: 5 });
    // The surcharge row never becomes a second Kentucky (no duplicate-state error) and never adds to the rate.
    expect(c.good).toHaveLength(2);
    expect(c.summary.withSurcharge).toBe(2);
  });

  it("folds a surcharge row that comes BEFORE its rate row", () => {
    const c = run(["Jurisdiction,Rate", "Kentucky Surcharge,0.102", "Kentucky,0.246"].join("\n"));
    expect(c.problemCount).toBe(0);
    expect(byCode(c).KY).toMatchObject({ rate: "0.2460", surcharge: "0.1020", surchargeLine: 2 });
  });

  it("refuses an orphan surcharge row, a surcharge row with no number or two numbers, and a second different surcharge", () => {
    const c = run(["Jurisdiction,Rate,Surcharge", "Kentucky Surcharge,0.102,", "Virginia,0.31,", "Virginia Surcharge,,", "Indiana,0.55,", "Indiana Surcharge,0.10,0.12", "Texas,0.2,", "Texas Surcharge,0.01,", "Texas Surcharge,0.02,"].join("\n"));
    expect(errorsOn(c, 2)).toEqual([expect.stringContaining("no Kentucky rate row")]);
    expect(errorsOn(c, 4)).toEqual([expect.stringContaining("no rate")]);
    expect(errorsOn(c, 6)).toEqual([expect.stringContaining("two different numbers")]);
    expect(errorsOn(c, 9)).toEqual([expect.stringContaining("line 8 already")]);
    expect(byCode(c).TX).toMatchObject({ surcharge: "0.0100" });
    expect(byCode(c).VA).toMatchObject({ surcharge: "0.0000" });
    expect(byCode(c).KY).toBeUndefined();
    expect(c.problemCount).toBe(4);
  });

  it("a Surcharge column that disagrees with the state's surcharge row is a problem; agreeing or 0.0000 is not", () => {
    const c = run(["Jurisdiction,Rate,Surcharge", "Kentucky,0.246,0.05", "Kentucky Surcharge,0.102,", "Virginia,0.31,0.143", "Virginia Surcharge,0.143,", "Indiana,0.55,0.0000", "Indiana Surcharge,0.12,"].join("\n"));
    expect(errorsOn(c, 3)).toEqual([expect.stringContaining("says 0.0500")]);
    expect(byCode(c).KY).toMatchObject({ surcharge: "0.0500" });
    expect(byCode(c).VA).toMatchObject({ surcharge: "0.1430" });
    expect(byCode(c).IN).toMatchObject({ surcharge: "0.1200", surchargeLine: 7 });
    expect(c.duplicates).toBe(1);
  });

  it("puts empty, negative, split and unknown cells on their line, never a silent skip", () => {
    const c = run(["Jurisdiction,Rate,Surcharge", "Texas,,", "Oklahoma,-0.19,", "Kansas,0.26/0.27,", "Narnia,0.2,", ",0.2,", "Iowa,0.325,-0.01", "Ohio,0.47,"].join("\n"));
    expect(errorsOn(c, 2)).toEqual([expect.stringContaining("Rate is empty")]);
    expect(errorsOn(c, 3)).toEqual([expect.stringContaining("negative")]);
    expect(errorsOn(c, 4)).toEqual([expect.stringContaining("two rates")]);
    expect(errorsOn(c, 5)).toEqual([expect.stringContaining("not a US state")]);
    expect(errorsOn(c, 6)).toEqual(["Jurisdiction is empty."]);
    expect(errorsOn(c, 7)).toEqual([expect.stringContaining("Surcharge is negative")]);
    expect(c.problemCount).toBe(6);
    expect(c.good.map((g) => g.item.jurisdiction)).toEqual(["OH"]);
  });

  it("a state twice: the same row is a duplicate, a different rate is a problem", () => {
    const c = run(["Jurisdiction,Rate", "Texas,0.20", "TX,0.2000", "Texas,0.21"].join("\n"));
    expect(c.duplicates).toBe(1);
    expect(errorsOn(c, 4)).toEqual([expect.stringContaining("line 2 already")]);
    expect(byCode(c).TX!.rate).toBe("0.2000");
  });

  it("checks a quarter column against the chosen quarter, and takes a row's status over the file's", () => {
    const c = run(["Jurisdiction,Rate,Quarter,Status", "Texas,0.2,2026Q3,final", "Ohio,0.47,Q3 2026,", "Iowa,0.3,2026-Q2,", "Utah,0.3,soon,", "Idaho,0.32,,draft"].join("\n"), { status: "provisional" });
    expect(byCode(c).TX!.status).toBe("final");
    expect(byCode(c).OH!.status).toBe("provisional");
    expect(errorsOn(c, 4)).toEqual(["This row is for 2026-Q2, not 2026-Q3."]);
    expect(errorsOn(c, 5)).toEqual([expect.stringContaining("not a quarter")]);
    expect(errorsOn(c, 6)).toEqual(["Status is not provisional or final."]);
    expect(c.summary).toMatchObject({ final: 1, provisional: 1 });
  });

  it("a surcharge row whose status differs from its rate row is a problem", () => {
    const c = run(["Jurisdiction,Rate,Status", "Kentucky,0.246,final", "Kentucky Surcharge,0.102,provisional"].join("\n"));
    expect(errorsOn(c, 3)).toEqual([expect.stringContaining("is provisional")]);
    expect(byCode(c).KY).toMatchObject({ status: "final", surcharge: "0.0000" });
  });

  it("refuses a file that is far longer than any rate table", () => {
    const rows = ["Jurisdiction,Rate", ...Array.from({ length: 501 }, () => "Texas,0.2")];
    expect(run(rows.join("\n")).tooMany).toBe(true);
  });
});

describe("IFTA sample rates", () => {
  it("are made up, the same every time for a quarter, valid, and give three states a surcharge", () => {
    const a = sampleIftaRates("2026-Q3");
    expect(a).toEqual(sampleIftaRates("2026-Q3"));
    expect(a).not.toEqual(sampleIftaRates("2026-Q4"));
    expect(a.map((r) => r.jurisdiction)).toEqual(SAMPLE_JURISDICTIONS);
    expect(a).toHaveLength(48);
    for (const r of a) {
      expect(readRate(r.rate)).toBe(r.rate);
      expect(readRate(r.surcharge)).toBe(r.surcharge);
      expect(Number(r.rate)).toBeGreaterThanOrEqual(0.2);
      expect(Number(r.rate)).toBeLessThan(0.65);
    }
    expect(a.filter((r) => r.surcharge !== "0.0000").map((r) => r.jurisdiction)).toEqual(["IN", "KY", "VA"]);
  });
});
