import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { classifyLine, defaultTaxYear, form1099Threshold, fromCents, profileGaps, tallyLines, thresholdNote, toCents } from "../src/lib/form1099";
import { validateDriverTax } from "../src/lib/fleet-forms";

/**
 * The contractor 1099 rules (docs/MONEY_PLAN.md, Wave 4 step 2): the year-aware threshold, gross against net from the statement rows, a negative adjustment kept out of gross, whole cents,
 * and the tax profile that never holds more than the last four digits of an SSN or EIN.
 */
const c = (kind: string, amount: string) => ({ kind, cents: toCents(amount)! });

describe("the reporting threshold", () => {
  test("$600 for 2025 payments, $2,000 from 2026", () => {
    expect(form1099Threshold(2024)).toBe(600);
    expect(form1099Threshold(2025)).toBe(600);
    expect(form1099Threshold(2026)).toBe(2000);
    expect(form1099Threshold(2027)).toBe(2000);
  });

  test("it always says to confirm with the accountant", () => {
    expect(thresholdNote(2026)).toBe("Reporting threshold $2,000 for 2026 payments (confirm with your accountant).");
    expect(thresholdNote(2025)).toContain("$600");
    expect(thresholdNote(2025)).toContain("confirm with your accountant");
  });

  test("the page opens on last year", () => {
    expect(defaultTaxYear(2027)).toBe(2026);
  });
});

describe("gross and net from the rows", () => {
  test("gross is the pay; net is every row; fuel and a negative adjustment are money off", () => {
    const t = tallyLines([c("load", "1500.00"), c("load", "820.55"), c("adjustment", "250"), c("adjustment", "-75.25"), c("fuel", "-412.10")]);
    expect(fromCents(t.grossCents)).toBe(2570.55);
    expect(fromCents(t.netCents)).toBe(2083.2);
    expect(fromCents(t.offCents)).toBe(-487.35);
    expect(t.unknownKinds).toEqual([]);
  });

  test("a negative adjustment never lowers gross; a positive one (a bonus) adds to it", () => {
    expect(classifyLine("adjustment", -100)).toBe("off");
    expect(classifyLine("adjustment", 100)).toBe("gross");
    expect(classifyLine("load", 0)).toBe("gross");
    expect(classifyLine("fuel", -1)).toBe("off");
    const t = tallyLines([c("load", "100"), c("adjustment", "-100")]);
    expect(t.grossCents).toBe(10000);
    expect(t.netCents).toBe(0);
  });

  test("a kind the rules do not know is counted in net, never in gross, and named", () => {
    const t = tallyLines([c("load", "10"), c("bonus_pool", "-5"), c("advance", "50")]);
    expect(t.grossCents).toBe(1000);
    expect(t.netCents).toBe(5500);
    expect(t.unknownKinds).toEqual(["advance", "bonus_pool"]);
  });

  test("sums are exact to the cent (no floating drift)", () => {
    const many = Array.from({ length: 1000 }, () => c("load", "0.10"));
    expect(fromCents(tallyLines(many).grossCents)).toBe(100);
    expect(fromCents(tallyLines([c("load", "0.1"), c("load", "0.2")]).grossCents)).toBe(0.3);
    expect(toCents("-0.05")).toBe(-5);
    expect(toCents("12.3")).toBe(1230);
    expect(toCents("12.345")).toBeNull();
    expect(toCents("abc")).toBeNull();
  });
});

describe("the tax profile", () => {
  test("only the last four digits: a full SSN or EIN is refused, however it is typed", () => {
    for (const full of ["123456789", "123-45-6789", "12-3456789", "12345", " 1234 5"]) {
      const out = validateDriverTax({ tinType: "ssn", tinLast4: full });
      expect(out.ok, full).toBe(false);
      if (!out.ok) expect(out.errors.tinLast4, full).toContain("Only the last four digits");
    }
    expect(validateDriverTax({ tinType: "ssn", tinLast4: "4821", tinStatus: "collected" })).toMatchObject({ ok: true, value: { tinLast4: "4821", tinType: "ssn", tinStatus: "collected" } });
    expect(validateDriverTax({ tinLast4: "48a1" }).ok).toBe(false);
    expect(validateDriverTax({ tinLast4: "482" }).ok).toBe(false);
  });

  test("collected or verified needs the type and the last four; the address is all or nothing", () => {
    expect(validateDriverTax({ tinStatus: "verified" })).toMatchObject({ ok: false });
    expect(validateDriverTax({ tinType: "ein", tinLast4: "0001", tinStatus: "verified" }).ok).toBe(true);
    expect(validateDriverTax({ tinStatus: "lost" }).ok).toBe(false);
    const half = validateDriverTax({ taxAddressLine1: "12 Main St" });
    expect(half.ok).toBe(false);
    if (!half.ok) expect(Object.keys(half.errors).sort()).toEqual(["taxCity", "taxState", "taxZip"]);
    expect(validateDriverTax({ taxAddressLine1: "12 Main St", taxCity: "Dallas", taxState: "tx", taxZip: "75201-1234" })).toMatchObject({ ok: true, value: { taxState: "TX" } });
    expect(validateDriverTax({ taxAddressLine1: "12 Main St", taxCity: "Dallas", taxState: "ZZ", taxZip: "7520" }).ok).toBe(false);
  });

  test("what a 1099 is missing", () => {
    const blank = { legalName: null, tinType: null, tinLast4: null, tinStatus: "none", taxAddressLine1: null, taxCity: null, taxState: null, taxZip: null };
    expect(profileGaps(blank)).toEqual(["legal name", "TIN last four", "TIN not collected", "mailing address"]);
    expect(profileGaps({ legalName: "Ana Ruiz", tinType: "ssn", tinLast4: "4821", tinStatus: "collected", taxAddressLine1: "1 A St", taxCity: "Dallas", taxState: "TX", taxZip: "75201" })).toEqual([]);
  });

  test("the schema has no column that could hold a full SSN or EIN, and the database refuses more than four digits", () => {
    const root = path.join(__dirname, "..", "..", "..");
    const schema = readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
    const driver = /\nmodel Driver \{([\s\S]*?)\n\}/.exec(schema)![1]!;
    const fields = driver.split("\n").map((l) => l.trim()).filter((l) => /^[a-zA-Z]/.test(l)).map((l) => l.split(/\s+/)[0]!);
    const taxish = fields.filter((f) => /ssn|ein\b|tin|taxid|taxId|social/i.test(f));
    expect(taxish.sort()).toEqual(["tinLast4", "tinStatus", "tinType"]);
    // No model anywhere carries a full number.
    expect(schema).not.toMatch(/\b(ssn|fullSsn|fullTin|taxIdNumber|tinFull|socialSecurity\w*)\b\s+String/i);
    const sql = readFileSync(path.join(root, "prisma", "migrations", "20261217000000_driver_tax_profile", "migration.sql"), "utf8");
    expect(sql).toContain(`CHECK ("tin_last4" IS NULL OR "tin_last4" ~ '^[0-9]{4}$')`);
  });
});
