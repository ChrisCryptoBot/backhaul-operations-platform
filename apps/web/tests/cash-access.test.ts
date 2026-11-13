import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Who sees cash (money plan Wave 6 step 4): the billing office. On the KPI dashboard (which every desk role opens) the cash card and its file link appear only with the `bill` capability; the file
 * itself asks for it at the route; Why it moved (where the cash bridge sits) is a `bill` page. Gross is never lowered by a fee (gap 6, rule 2): the cash code never writes a load's money.
 */
const SRC = join(__dirname, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8").split(String.fromCharCode(13)).join("");

describe("cash is the billing office's", () => {
  test("the KPI page reads cash only with bill, and offers its file only then", () => {
    const page = read("app/(desk)/kpi/page.tsx");
    expect(page).toMatch(/const cash = billAccess\.ok \? await getKpiCash\(/);
    expect(page).toMatch(/\{billAccess\.ok \? <a href=\{csv\("kpi-cash"\)\}>/);
  });

  test("the file asks for bill at the route, and is a listed export kind", () => {
    expect(read("app/(desk)/export/[kind]/route.ts")).toMatch(/params\.kind === "kpi-cash"\) \{\s*const noBill = await guardRoute\("bill"\)/);
    expect(read("server/tl/exports.ts")).toMatch(/"kpi-trucks", "kpi-cash", "leaks"/);
  });

  test("Why it moved, where the cash bridge sits, is a bill page", () => {
    expect(read("app/(desk)/kpi/moved/page.tsx")).toMatch(/requirePage\("bill"\)/);
  });

  test("the cash code only reads: it never writes a load's or an invoice's money", () => {
    for (const f of ["lib/cash.ts", "server/tl/cash.ts"]) expect(read(f), f).not.toMatch(/\.(update|create|upsert|delete)(Many)?\(/);
  });
});
